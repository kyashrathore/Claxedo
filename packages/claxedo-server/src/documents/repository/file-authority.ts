import { constants } from "node:fs"
import fs from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"
import {
  DocumentInvalidEntryError,
  DocumentNotFoundError,
  DocumentNotTextError,
  DocumentPathError,
  DocumentTooLargeError,
  DocumentVersionConflictError,
  documentErrorFromCause,
  nodeErrorCode,
} from "../errors"
import type { DocumentRead, DocumentVersion } from "../port"
import { contentHash, documentVersionsMatch, localDocumentVersion } from "../version"
import { BoundedFileTooLargeError, readBoundedFile } from "../bounded-file-read"
import { syncDirectory } from "../durable-fs"

const DEFAULT_SCAN_CONCURRENCY = 8
const MAX_RECOVERY_SCAN_CANDIDATES = 10_000
const MAX_RECOVERY_SCAN_DEPTH = 64
const RECOVERY_SCAN_IGNORED_DIRECTORIES = new Set([".git", ".claxedo", "node_modules"])
const MERGE_CONFLICT_MARKER = /^(?:<{7}|\|{7}|={7}|>{7})(?: |$)/m
const writeQueues = new Map<string, Promise<void>>()

export type RepositoryDocumentRead = DocumentRead & Readonly<{ sourceHint?: "merge-conflict-markers" }>

export type RepositoryFileAuthority = Readonly<{
  resolve(root: string, relativePath: string): Promise<string>
  canonicalIdentity(root: string, relativePath: string): Promise<string>
  read(documentId: string, target: string, maxBytes: number): Promise<RepositoryDocumentRead>
  compareAndSwap(
    root: string,
    documentId: string,
    target: string,
    markdown: string,
    expectedVersion: DocumentVersion | null,
    maxBytes: number,
  ): Promise<RepositoryDocumentRead>
  findByVersion(root: string, expectedVersion: DocumentVersion, maxBytes: number): Promise<string | undefined>
}>

export type LocalRepositoryFileAuthorityOptions = Readonly<{
  scanConcurrency?: number
  caseInsensitive?: boolean
  faults?: Readonly<{
    beforeScanCandidate?: (candidate: string) => void | Promise<void>
    afterAuthorityClaimed?: (input: Readonly<{ target: string; claimedPath: string }>) => void | Promise<void>
    afterReplacementInstalled?: (input: Readonly<{ target: string; claimedPath: string }>) => void | Promise<void>
  }>
}>

export function createLocalRepositoryFileAuthority(
  options: LocalRepositoryFileAuthorityOptions = {},
): RepositoryFileAuthority {
  const scanConcurrency = Math.max(1, Math.floor(options.scanConcurrency ?? DEFAULT_SCAN_CONCURRENCY))
  const caseInsensitive = options.caseInsensitive ?? process.platform === "win32"

  return {
    resolve: resolveRepositoryPath,

    async canonicalIdentity(root, relativePath) {
      const canonical = (await resolveRepositoryPath(root, relativePath)).normalize("NFC")
      return caseInsensitive ? canonical.toLocaleLowerCase("en-US") : canonical
    },

    read: readRepositoryFile,

    compareAndSwap(root, documentId, target, markdown, expectedVersion, maxBytes) {
      return serializeRepositoryOperation(writeQueues, target, async () => {
        validateMarkdown(markdown, maxBytes)
        await atomicRepositoryReplace(root, documentId, target, markdown, expectedVersion, maxBytes, options.faults)
        const installed = await readRepositoryFile(documentId, target, maxBytes)
        if (contentHash(installed.markdown) !== contentHash(markdown)) {
          throw new DocumentVersionConflictError(installed.version)
        }
        // Node does not expose renameat2/openat-style directory-relative CAS.
        // A writer after this final descriptor-backed read is an ordinary later
        // external change and is detected by the next read/watch/save CAS.
        return installed
      })
    },

    async findByVersion(root, expectedVersion, maxBytes) {
      const files = await walk(root)
      const matches = await mapLimit(files, scanConcurrency, async (candidate) => {
        await options.faults?.beforeScanCandidate?.(candidate)
        const current = await readRepositoryFile("recovery", candidate, maxBytes).catch((error: unknown) => {
          if (
            error instanceof DocumentNotFoundError ||
            error instanceof DocumentNotTextError ||
            error instanceof DocumentTooLargeError
          )
            return undefined
          throw error
        })
        return current && documentVersionsMatch(expectedVersion, current.version) ? candidate : undefined
      })
      const matching = matches.filter((candidate): candidate is string => Boolean(candidate))
      return matching.length === 1 ? path.relative(await fs.realpath(root), matching[0]) : undefined
    },
  }

  async function resolveRepositoryPath(root: string, relativePath: string) {
    const normalized = normalizeRepositoryRelativePath(relativePath)
    const realRoot = await fs.realpath(root)
    const candidate = path.resolve(realRoot, normalized)
    if (!insideRepository(realRoot, candidate))
      throw new DocumentPathError("Repository document path escapes its workspace root")
    const existing = await nearestExistingPath(candidate)
    const realExisting = await fs.realpath(existing).catch((error: unknown) => {
      if (nodeErrorCode(error) === "ENOENT") {
        throw new DocumentPathError("Repository document path contains a broken symlink", { cause: error })
      }
      throw error
    })
    if (!insideRepository(realRoot, realExisting))
      throw new DocumentPathError("Repository document symlink escapes its workspace root")
    const resolved = path.resolve(realExisting, path.relative(existing, candidate))
    if (!insideRepository(realRoot, resolved))
      throw new DocumentPathError("Repository document path escapes its workspace root")
    return resolved
  }
}

type RepositoryPinnedTarget = Readonly<{
  root: string
  target: string
  parent: string
  parentHandle: FileHandle
  parentIdentity: Readonly<{ dev: number; ino: number }>
}>

export async function atomicRepositoryReplace(
  root: string,
  documentId: string,
  target: string,
  markdown: string,
  expectedVersion: DocumentVersion | null,
  maxBytes: number,
  faults: LocalRepositoryFileAuthorityOptions["faults"],
) {
  const pinned = await pinRepositoryTarget(root, target)
  const temporary = path.join(pinned.parent, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`)
  const claimedPath = path.join(pinned.parent, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.claim`)
  let claimed = false
  let installed = false
  let committed = false
  try {
    const file = await fs.open(temporary, "wx", 0o600)
    try {
      await file.writeFile(markdown)
      await file.sync()
    } finally {
      await file.close()
    }
    await verifyRepositoryParent(pinned)

    let claimedVersion: DocumentVersion | null = null
    let claimedIdentity: Readonly<{ dev: number; ino: number }> | undefined
    if (expectedVersion !== null) {
      await fs.rename(target, claimedPath).catch((error: unknown) => {
        if (nodeErrorCode(error) === "ENOENT") throw new DocumentVersionConflictError(null)
        throw error
      })
      claimed = true
      await verifyRepositoryParent(pinned)
      const authority = await readPinnedRepositoryFile(claimedPath, documentId, maxBytes, pinned)
      claimedVersion = authority.version
      claimedIdentity = authority.identity
      if (!documentVersionsMatch(expectedVersion, claimedVersion))
        throw new DocumentVersionConflictError(claimedVersion)
      await faults?.afterAuthorityClaimed?.({ target, claimedPath })
    } else if (await pathExists(target)) {
      throw new DocumentVersionConflictError(await repositoryCurrentVersion(target, maxBytes))
    }

    await verifyRepositoryParent(pinned)
    await fs.link(temporary, target).catch(async (error: unknown) => {
      if (nodeErrorCode(error) === "EEXIST") {
        throw new DocumentVersionConflictError(await repositoryCurrentVersion(target, maxBytes))
      }
      throw error
    })
    installed = true
    if (claimed) await faults?.afterReplacementInstalled?.({ target, claimedPath })
    await verifyRepositoryParent(pinned)
    await verifySameInode(target, temporary)

    if (claimed && claimedIdentity && claimedVersion) {
      const revalidated = await readPinnedRepositoryFile(claimedPath, documentId, maxBytes, pinned)
      if (
        revalidated.identity.dev !== claimedIdentity.dev ||
        revalidated.identity.ino !== claimedIdentity.ino ||
        !documentVersionsMatch(claimedVersion, revalidated.version)
      ) {
        throw new DocumentVersionConflictError(revalidated.version)
      }
    }

    await syncDirectory(pinned.parent)
    await verifySameInode(target, temporary)
    const installedRead = await readPinnedRepositoryFile(target, documentId, maxBytes, pinned)
    if (contentHash(installedRead.content) !== contentHash(markdown)) {
      throw new DocumentVersionConflictError(installedRead.version)
    }
    committed = true
    await cleanupRepositoryReplacement(temporary, claimed ? claimedPath : undefined, pinned.parent)
  } catch (error) {
    const parentSafe = await repositoryParentIsPinned(pinned)
    let conflictVersion = error instanceof DocumentVersionConflictError ? error.currentVersion : undefined
    if (parentSafe && !committed && installed) {
      conflictVersion = await rollbackRepositoryReplacement(
        pinned,
        temporary,
        claimed ? claimedPath : undefined,
        maxBytes,
        contentHash(markdown),
      )
      installed = false
      claimed = false
    } else if (parentSafe && !committed && claimed) {
      conflictVersion = await restoreRepositoryClaim(pinned, claimedPath, maxBytes)
      claimed = false
    }
    // Node cannot unlink/rename relative to the pinned directory descriptor.
    // If the parent pathname changed, leave artifacts on the detached original
    // inode rather than follow the replacement path and risk touching outside.
    if (parentSafe) await removeIfPresent(temporary)
    if (error instanceof DocumentVersionConflictError) throw new DocumentVersionConflictError(conflictVersion ?? null)
    if (committed) {
      console.warn(`[claxedo-server] committed repository document ${documentId} with cleanup artifacts`, error)
      return
    }
    throw documentErrorFromCause(error, `writing repository document ${documentId}`, documentId)
  } finally {
    await pinned.parentHandle.close().catch((error: unknown) => {
      console.warn(`[claxedo-server] failed to close repository document ${documentId} parent handle`, error)
    })
  }
}

async function pinRepositoryTarget(root: string, target: string): Promise<RepositoryPinnedTarget> {
  const realRoot = await fs.realpath(root)
  const parent = await fs.realpath(path.dirname(target))
  if (!insideRepository(realRoot, parent) || !insideRepository(realRoot, path.resolve(target))) {
    throw new DocumentPathError("Repository document parent escapes its workspace root")
  }
  const parentHandle = await fs.open(parent, "r")
  const stat = await parentHandle.stat()
  const pinned = {
    root: realRoot,
    target,
    parent,
    parentHandle,
    parentIdentity: { dev: stat.dev, ino: stat.ino },
  }
  await verifyRepositoryParent(pinned)
  return pinned
}

async function verifyRepositoryParent(pinned: RepositoryPinnedTarget) {
  if (!(await repositoryParentIsPinned(pinned))) {
    throw new DocumentPathError("Repository document parent changed during write")
  }
}

async function repositoryParentIsPinned(pinned: RepositoryPinnedTarget) {
  const real = await fs.realpath(pinned.parent).catch(() => undefined)
  if (!real || !insideRepository(pinned.root, real)) return false
  const stat = await fs.stat(real).catch(() => undefined)
  return !!stat && stat.dev === pinned.parentIdentity.dev && stat.ino === pinned.parentIdentity.ino
}

async function readPinnedRepositoryFile(
  target: string,
  documentId: string,
  maxBytes: number,
  pinned?: RepositoryPinnedTarget,
) {
  for (const _attempt of [0, 1, 2]) {
    if (pinned) await verifyRepositoryParent(pinned)
    const file = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
      if (nodeErrorCode(error) === "ENOENT") throw new DocumentNotFoundError(documentId, { cause: error })
      if (nodeErrorCode(error) === "ELOOP")
        throw new DocumentPathError("Repository document target became a symlink", { cause: error })
      throw documentErrorFromCause(error, `reading repository document ${documentId}`, documentId)
    })
    try {
      if (pinned) await verifyRepositoryParent(pinned)
      const { before, content, after } = await readBoundedFile(file, maxBytes).catch((error: unknown) => {
        if (error instanceof BoundedFileTooLargeError) throw new DocumentTooLargeError(error.actualBytes, maxBytes)
        throw error
      })
      if (!before.isFile()) throw new DocumentPathError("Repository document target is not a regular file")
      if (pinned) await verifyRepositoryParent(pinned)
      const current = await fs.stat(target).catch((error: unknown) => {
        if (nodeErrorCode(error) === "ENOENT") return undefined
        throw error
      })
      if (
        current &&
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        content.byteLength === after.size &&
        after.dev === current.dev &&
        after.ino === current.ino
      ) {
        return {
          content,
          identity: { dev: after.dev, ino: after.ino },
          version: localDocumentVersion(content, after),
          modifiedAt: after.mtimeMs,
        }
      }
    } finally {
      await file.close()
    }
  }
  throw new DocumentVersionConflictError(null)
}

async function verifySameInode(left: string, right: string) {
  const [leftStat, rightStat] = await Promise.all([fs.stat(left), fs.stat(right)])
  if (leftStat.dev !== rightStat.dev || leftStat.ino !== rightStat.ino) throw new DocumentVersionConflictError(null)
}

async function rollbackRepositoryReplacement(
  pinned: RepositoryPinnedTarget,
  temporary: string,
  claimedPath: string | undefined,
  maxBytes: number,
  installedHash: string,
) {
  await verifyRepositoryParent(pinned)
  const [target, source] = await Promise.all([statIfPresent(pinned.target), statIfPresent(temporary)])
  const installed =
    target && source && target.dev === source.dev && target.ino === source.ino
      ? await readPinnedRepositoryFile(pinned.target, "rollback", maxBytes, pinned).catch(() => undefined)
      : undefined
  const installedStillOurs =
    target &&
    source &&
    target.dev === source.dev &&
    target.ino === source.ino &&
    installed &&
    installed.identity.dev === target.dev &&
    installed.identity.ino === target.ino &&
    contentHash(installed.content) === installedHash
  if (installedStillOurs) await fs.unlink(pinned.target)
  if (claimedPath && !(await pathExists(pinned.target))) {
    await fs.link(claimedPath, pinned.target).catch((error: unknown) => {
      if (nodeErrorCode(error) !== "EEXIST") throw error
    })
    if (await sameInode(claimedPath, pinned.target)) await removeIfPresent(claimedPath)
  }
  if (claimedPath && (await pathExists(pinned.target))) await removeIfPresent(claimedPath)
  await syncDirectory(pinned.parent)
  await removeIfPresent(temporary)
  return await repositoryCurrentVersion(pinned.target, maxBytes)
}

async function restoreRepositoryClaim(pinned: RepositoryPinnedTarget, claimedPath: string, maxBytes: number) {
  await verifyRepositoryParent(pinned)
  if (!(await pathExists(pinned.target))) {
    await fs.link(claimedPath, pinned.target).catch((error: unknown) => {
      if (nodeErrorCode(error) !== "EEXIST") throw error
    })
    if (await sameInode(claimedPath, pinned.target)) await removeIfPresent(claimedPath)
    await syncDirectory(pinned.parent)
  }
  if (await pathExists(pinned.target)) await removeIfPresent(claimedPath)
  return await repositoryCurrentVersion(pinned.target, maxBytes)
}

async function cleanupRepositoryReplacement(temporary: string, claimedPath: string | undefined, parent: string) {
  if (claimedPath) await removeIfPresent(claimedPath)
  await removeIfPresent(temporary)
  await syncDirectory(parent)
}

async function repositoryCurrentVersion(target: string, maxBytes: number) {
  return await readPinnedRepositoryFile(target, "current", maxBytes)
    .then((current) => current.version)
    .catch((error: unknown) => {
      if (error instanceof DocumentNotFoundError) return null
      throw error
    })
}

async function sameInode(left: string, right: string) {
  const [leftStat, rightStat] = await Promise.all([fs.stat(left), fs.stat(right)])
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino
}

async function statIfPresent(target: string) {
  return await fs.stat(target).catch((error: unknown) => {
    if (nodeErrorCode(error) === "ENOENT") return undefined
    throw error
  })
}

async function pathExists(target: string) {
  return !!(await statIfPresent(target))
}

async function removeIfPresent(target: string) {
  await fs.rm(target, { force: true })
}

export function normalizeRepositoryRelativePath(input: string) {
  const value = input.trim()
  if (!value || value.includes("\0")) throw new DocumentPathError("Repository document path is invalid")
  if (path.isAbsolute(value)) throw new DocumentPathError("Repository document path must be relative")
  const normalized = path.normalize(value)
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new DocumentPathError("Repository document path escapes its workspace root")
  }
  return normalized
}

export async function readRepositoryFile(
  documentId: string,
  target: string,
  maxBytes: number,
): Promise<RepositoryDocumentRead> {
  const current = await readPinnedRepositoryFile(target, documentId, maxBytes)
  try {
    const markdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(current.content)
    if (markdown.includes("\0")) throw new Error("NUL byte")
    return {
      markdown,
      version: current.version,
      modifiedAt: current.modifiedAt,
      ...(MERGE_CONFLICT_MARKER.test(markdown) ? { sourceHint: "merge-conflict-markers" as const } : {}),
    }
  } catch (error) {
    throw new DocumentNotTextError(documentId, current.version, { cause: error })
  }
}

function validateMarkdown(markdown: string, maxBytes: number) {
  const size = Buffer.byteLength(markdown)
  if (size > maxBytes) throw new DocumentTooLargeError(size, maxBytes)
  if (markdown.includes("\0")) throw new DocumentInvalidEntryError("Document Markdown cannot contain NUL bytes")
}

export function insideRepository(root: string, candidate: string) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

async function nearestExistingPath(input: string): Promise<string> {
  const found = await fs.lstat(input).then(
    () => true,
    (error: unknown) => {
      if (nodeErrorCode(error) === "ENOENT") return false
      throw error
    },
  )
  if (found) return input
  const parent = path.dirname(input)
  if (parent === input) throw new DocumentPathError("Repository document path has no existing root")
  return await nearestExistingPath(parent)
}

async function walk(root: string): Promise<string[]> {
  const directories = [{ directory: root, depth: 0 }]
  const files: string[] = []
  while (directories.length) {
    const current = directories.shift()!
    if (current.depth > MAX_RECOVERY_SCAN_DEPTH) {
      throw new DocumentInvalidEntryError("Repository recovery scan exceeded its depth limit")
    }
    const entries = await fs.readdir(current.directory, { withFileTypes: true })
    entries.forEach((entry) => {
      if (entry.isDirectory() && !RECOVERY_SCAN_IGNORED_DIRECTORIES.has(entry.name)) {
        directories.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 })
      }
      if (entry.isFile()) files.push(path.join(current.directory, entry.name))
    })
    if (files.length + directories.length > MAX_RECOVERY_SCAN_CANDIDATES) {
      throw new DocumentInvalidEntryError("Repository recovery scan exceeded its candidate limit")
    }
  }
  return files
}

async function mapLimit<T, R>(items: readonly T[], concurrency: number, operation: (item: T) => Promise<R>) {
  let next = 0
  const results = new Array<R>(items.length)
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        results[index] = await operation(items[index])
      }
    }),
  )
  return results
}

export async function serializeRepositoryOperation<T>(
  queues: Map<string, Promise<void>>,
  key: string,
  run: () => Promise<T>,
) {
  const previous = queues.get(key) ?? Promise.resolve()
  let release: () => void = () => undefined
  const current = previous.then(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  queues.set(key, current)
  await previous
  try {
    return await run()
  } finally {
    release()
    if (queues.get(key) === current) queues.delete(key)
  }
}
