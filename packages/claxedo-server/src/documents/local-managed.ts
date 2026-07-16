import { constants } from "node:fs"
import fs from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { dataDir } from "../paths"
import {
  DocumentAlreadyExistsError,
  DocumentInvalidEntryError,
  DocumentLockTimeoutError,
  DocumentNotFoundError,
  DocumentNotTextError,
  DocumentPathError,
  DocumentTooLargeError,
  DocumentVersionConflictError,
  documentErrorFromCause,
  nodeErrorCode,
} from "./errors"
import { createDocumentHistory } from "./history"
import type {
  DocumentActor,
  DocumentEntry,
  DocumentHandle,
  DocumentRead,
  DocumentVersion,
  DocumentWorkspace,
  SnapshotID,
  SnapshotRequest,
  WriteResult,
} from "./port"
import { documentVersionsMatch, localDocumentVersion } from "./version"

const DEFAULT_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_SNAPSHOTS = 50
const DEFAULT_MAX_SNAPSHOT_AGE_MS = 30 * 24 * 60 * 60 * 1_000
const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 2_000
const LOCK_HEARTBEAT_MS = 5_000

export type LocalManagedDocumentHandle = DocumentHandle &
  Readonly<{
    origin: "managed"
    placement: "local"
    relativePath: string
    canonicalPath: string
  }>

type FaultTarget = Readonly<{ target: string; parent: string }>
type ClaimedFaultTarget = FaultTarget & Readonly<{ claimedPath: string }>

export type LocalManagedOptions = Readonly<{
  dataRoot?: string
  maxDocumentBytes?: number
  history?: Readonly<{
    maxSnapshots?: number
    maxAgeMs?: number
    faults?: Readonly<{
      beforeMkdir?: () => void | Promise<void>
      beforeCleanup?: () => void | Promise<void>
      beforeContentCleanup?: (snapshotId: SnapshotID) => void | Promise<void>
    }>
  }>
  locking?: Readonly<{
    staleMs?: number
    waitMs?: number
    heartbeatMs?: number
  }>
  faults?: Readonly<{
    beforeTempOpen?: () => void | Promise<void>
    beforeRename?: () => void | Promise<void>
    beforeReadOpen?: (input: FaultTarget) => void | Promise<void>
    beforeAuthorityClaim?: (input: FaultTarget) => void | Promise<void>
    afterAuthorityClaimed?: (input: ClaimedFaultTarget) => void | Promise<void>
    afterReplacementInstalled?: (input: ClaimedFaultTarget) => void | Promise<void>
    beforeDirectoryFsync?: (input: FaultTarget) => void | Promise<void>
  }>
}>

type CreateRequest = Readonly<{
  markdown: string
  actor: DocumentActor
  sessionId?: string
}>

type LocalManagedEntry = Readonly<{
  origin: "managed"
  placement: "local"
  projectId: string
  documentId: string
  relativePath: string
}>

export type LocalManagedDocumentWorkspace = DocumentWorkspace<LocalManagedDocumentHandle> &
  Readonly<{
    create(entry: DocumentEntry, request: CreateRequest): Promise<WriteResult>
  }>

export function createLocalManagedDocumentWorkspace(options: LocalManagedOptions = {}): LocalManagedDocumentWorkspace {
  validateLockingOptions(options.locking)
  const root = path.resolve(options.dataRoot ?? dataDir())
  const documentsRoot = path.join(root, "documents")
  const maxDocumentBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES
  const history = createDocumentHistory({
    root,
    maxSnapshots: options.history?.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS,
    maxAgeMs: options.history?.maxAgeMs ?? DEFAULT_MAX_SNAPSHOT_AGE_MS,
    ...(options.history?.faults ? { faults: options.history.faults } : {}),
  })

  return {
    async create(entry, request) {
      validateText(request.markdown, maxDocumentBytes)
      const handle = await resolve(entry)
      return await withDocumentLock(root, handle.documentId, options.locking, async () => {
        const target = await resolvePinnedPath(documentsRoot, handle.relativePath)
        if (await exists(target)) throw new DocumentAlreadyExistsError(handle.documentId)
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
        await atomicReplace(handle, documentsRoot, request.markdown, null, maxDocumentBytes, false, options.faults)
        const read = await readDocument(handle, maxDocumentBytes, documentsRoot, options.faults)
        const snapshot = await history.create(handle.documentId, {
          markdown: read.markdown,
          reason: "document.created",
          actor: request.actor,
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        })
        return { ...read, snapshot }
      })
    },

    resolve,

    read: (handle) => readDocument(handle, maxDocumentBytes, documentsRoot, options.faults),

    async write(handle, request) {
      validateHandle(handle)
      validateText(request.markdown, maxDocumentBytes)
      return await withDocumentLock(root, handle.documentId, options.locking, async () => {
        const current = await readDocument(handle, maxDocumentBytes, documentsRoot, options.faults)
        if (!documentVersionsMatch(request.expectedVersion, current.version)) {
          throw new DocumentVersionConflictError(current.version)
        }
        await history.create(handle.documentId, {
          markdown: current.markdown,
          reason: "document.before_write",
          actor: request.actor,
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        })
        await atomicReplace(handle, documentsRoot, request.markdown, request.expectedVersion, maxDocumentBytes, true, options.faults)
        const read = await readDocument(handle, maxDocumentBytes, documentsRoot, options.faults)
        const snapshot = await history.create(handle.documentId, {
          markdown: read.markdown,
          reason: "document.written",
          actor: request.actor,
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        })
        return { ...read, snapshot }
      })
    },

    snapshot: (handle, request) =>
      withDocumentLock(root, handle.documentId, options.locking, async () => {
        const current = await readDocument(handle, maxDocumentBytes, documentsRoot, options.faults)
        return await history.create(handle.documentId, { markdown: current.markdown, ...request })
      }),

    listSnapshots(handle) {
      validateHandle(handle)
      return history.list(handle.documentId)
    },

    async readSnapshot(handle, snapshotId) {
      validateHandle(handle)
      const snapshot = await history.read(handle.documentId, snapshotId)
      return {
        markdown: snapshot.markdown,
        version: localDocumentVersion(Buffer.from(snapshot.markdown), {
          size: snapshot.metadata.size,
          mtimeMs: snapshot.metadata.createdAt,
        }),
        modifiedAt: snapshot.metadata.createdAt,
      }
    },

    restore: (handle, snapshotId, request) =>
      withDocumentLock(root, handle.documentId, options.locking, async () => {
        validateHandle(handle)
        const desired = await history.read(handle.documentId, snapshotId)
        const target = await resolvePinnedPath(documentsRoot, handle.relativePath)
        const current = await readDocument(handle, maxDocumentBytes, documentsRoot, options.faults).catch((error: unknown) => {
          if (error instanceof DocumentNotFoundError) return undefined
          if (error instanceof DocumentNotTextError) return { markdown: undefined, version: error.currentVersion }
          throw error
        })
        if (!expectedVersionMatches(request.expectedVersion, current?.version ?? null)) {
          throw new DocumentVersionConflictError(current?.version ?? null)
        }
        if (current?.markdown !== undefined) {
          await history.create(handle.documentId, {
            markdown: current.markdown,
            reason: "document.before_restore",
            actor: request.actor,
            ...(request.sessionId ? { sessionId: request.sessionId } : {}),
          })
        }
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
        await atomicReplace(handle, documentsRoot, desired.markdown, request.expectedVersion, maxDocumentBytes, true, options.faults)
        const read = await readDocument(handle, maxDocumentBytes, documentsRoot, options.faults)
        const snapshot = await history.create(handle.documentId, {
          markdown: read.markdown,
          reason: `document.restored:${snapshotId}`,
          actor: request.actor,
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        })
        return { ...read, snapshot }
      }),

    pinSnapshot: (handle, snapshotId, pin) =>
      withDocumentLock(root, handle.documentId, options.locking, () => history.pin(handle.documentId, snapshotId, pin)),
    unpinSnapshot: (handle, snapshotId, pin) =>
      withDocumentLock(root, handle.documentId, options.locking, () => history.unpin(handle.documentId, snapshotId, pin)),
    collectSnapshots: (handle) =>
      withDocumentLock(root, handle.documentId, options.locking, () => history.collect(handle.documentId)),
  }

  async function resolve(entry: DocumentEntry): Promise<LocalManagedDocumentHandle> {
    validateEntry(entry)
    await fs.mkdir(documentsRoot, { recursive: true, mode: 0o700 }).catch((error: unknown) => {
      throw documentErrorFromCause(error, "creating the managed documents root")
    })
    return {
      origin: "managed",
      placement: "local",
      projectId: entry.projectId,
      documentId: entry.documentId,
      relativePath: entry.relativePath,
      canonicalPath: await resolvePinnedPath(documentsRoot, entry.relativePath),
    }
  }
}

function validateLockingOptions(options: LocalManagedOptions["locking"]) {
  if (!options) return
  if (options.staleMs !== undefined && (!Number.isFinite(options.staleMs) || options.staleMs <= 0)) {
    throw new DocumentInvalidEntryError("Document lock stale duration must be positive")
  }
  if (options.waitMs !== undefined && (!Number.isFinite(options.waitMs) || options.waitMs < 0)) {
    throw new DocumentInvalidEntryError("Document lock wait duration must be non-negative")
  }
  if (options.heartbeatMs !== undefined && (!Number.isFinite(options.heartbeatMs) || options.heartbeatMs <= 0)) {
    throw new DocumentInvalidEntryError("Document lock heartbeat duration must be positive")
  }
}

export function managedDocumentRelativePath(input: Readonly<{ projectId: string; documentId: string; slug: string }>) {
  requireIdentifier(input.projectId, "project id")
  requireIdentifier(input.documentId, "document id")
  const slug = input.slug
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "document"
  return `${input.projectId}/${input.documentId}/${slug}.md`
}

function validateEntry(entry: DocumentEntry): asserts entry is LocalManagedEntry {
  if (entry.origin !== "managed" || entry.placement !== "local") {
    throw new DocumentInvalidEntryError("The local managed backend requires a local managed entry")
  }
  requireIdentifier(entry.projectId, "project id")
  requireIdentifier(entry.documentId, "document id")
  if (entry.relativePath.includes("\0") || entry.relativePath.includes("\\") || path.isAbsolute(entry.relativePath)) {
    throw new DocumentInvalidEntryError("Managed document paths must be safe relative POSIX paths")
  }
  const segments = entry.relativePath.split("/")
  if (
    segments.length !== 3 ||
    segments[0] !== entry.projectId ||
    segments[1] !== entry.documentId ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(segments[2] ?? "")
  ) {
    throw new DocumentInvalidEntryError("Managed paths must be <project-id>/<document-id>/<ascii-slug>.md")
  }
}

function validateHandle(handle: LocalManagedDocumentHandle) {
  validateEntry(handle)
}

function requireIdentifier(value: string, label: string) {
  if (!/^[a-z0-9_-]+$/.test(value)) throw new DocumentInvalidEntryError(`Invalid ${label}`)
}

async function readDocument(
  handle: LocalManagedDocumentHandle,
  maxDocumentBytes: number,
  documentsRoot: string,
  faults: LocalManagedOptions["faults"],
): Promise<DocumentRead> {
  validateHandle(handle)
  const pinned = await pinDocumentTarget(documentsRoot, handle.relativePath)
  try {
    await faults?.beforeReadOpen?.({ target: pinned.target, parent: pinned.parent })
    const raw = await readPinnedFile(pinned, pinned.target, handle.documentId, maxDocumentBytes)
    const version = localDocumentVersion(raw.content, raw.stat)
    return {
      markdown: decodeText(raw.content, handle.documentId, version),
      version,
      modifiedAt: raw.stat.mtimeMs,
    }
  } finally {
    await pinned.parentHandle.close()
  }
}

type PinnedTarget = Readonly<{
  target: string
  parent: string
  parentDev: number
  parentIno: number
  parentHandle: FileHandle
}>

async function pinDocumentTarget(documentsRoot: string, relativePath: string): Promise<PinnedTarget> {
  const target = await resolvePinnedPath(documentsRoot, relativePath)
  const parent = await fs.realpath(path.dirname(target)).catch((error: unknown) => {
    throw documentErrorFromCause(error, "pinning a managed document parent")
  })
  const parentHandle = await fs.open(parent, constants.O_RDONLY).catch((error: unknown) => {
    throw documentErrorFromCause(error, "pinning a managed document parent")
  })
  try {
    const stat = await parentHandle.stat()
    return { target, parent, parentDev: stat.dev, parentIno: stat.ino, parentHandle }
  } catch (error) {
    await parentHandle.close()
    throw documentErrorFromCause(error, "pinning a managed document parent")
  }
}

async function verifyPinnedParent(pinned: PinnedTarget) {
  // Node exposes no descriptor-relative rename/link API. Keeping the parent
  // directory open and comparing its inode before and after every pathname
  // operation is the strongest portable guard; a syscall-sized swap between
  // a successful check and the following rename remains a platform limit.
  const real = await fs.realpath(pinned.parent).catch((error: unknown) => {
    throw new DocumentPathError("Managed document parent changed during access", { cause: error })
  })
  const [stat, anchored] = await Promise.all([fs.stat(real), pinned.parentHandle.stat()]).catch((error: unknown) => {
    throw new DocumentPathError("Managed document parent changed during access", { cause: error })
  })
  if (
    real !== pinned.parent ||
    stat.dev !== pinned.parentDev ||
    stat.ino !== pinned.parentIno ||
    anchored.dev !== pinned.parentDev ||
    anchored.ino !== pinned.parentIno
  ) {
    throw new DocumentPathError("Managed document parent changed during access")
  }
}

async function readPinnedFile(
  pinned: PinnedTarget,
  file: string,
  documentId: string,
  maxDocumentBytes: number,
) {
  for (const _attempt of [0, 1, 2]) {
    await verifyPinnedParent(pinned)
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
      if (nodeErrorCode(error) === "ELOOP") throw new DocumentPathError("Managed document target became a symlink", { cause: error })
      throw documentErrorFromCause(error, `reading document ${documentId}`, documentId)
    })
    try {
      await verifyPinnedParent(pinned)
      const before = await handle.stat()
      if (before.size > maxDocumentBytes) throw new DocumentTooLargeError(before.size, maxDocumentBytes)
      const content = await handle.readFile()
      const after = await handle.stat()
      await verifyPinnedParent(pinned)
      const current = await fs.stat(file).catch((error: unknown) => {
        throw documentErrorFromCause(error, `reading document ${documentId}`, documentId)
      })
      if (
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        after.dev === current.dev &&
        after.ino === current.ino
      ) {
        return { content, stat: after }
      }
    } finally {
      await handle.close()
    }
  }
  throw documentErrorFromCause(new Error("Document kept changing during read"), `reading document ${documentId}`)
}

function decodeText(content: Uint8Array, documentId: string, version: DocumentVersion) {
  if (content.includes(0)) throw new DocumentNotTextError(documentId, version)
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content)
  } catch (error) {
    throw new DocumentNotTextError(documentId, version, { cause: error })
  }
}

function validateText(markdown: string, maxDocumentBytes: number) {
  if (markdown.includes("\0")) throw new DocumentNotTextError("pending-write", localDocumentVersion(Buffer.from(markdown), { size: 0, mtimeMs: 0 }))
  const size = Buffer.byteLength(markdown)
  if (size > maxDocumentBytes) throw new DocumentTooLargeError(size, maxDocumentBytes)
}

async function atomicReplace(
  handle: LocalManagedDocumentHandle,
  documentsRoot: string,
  markdown: string,
  expectedVersion: DocumentVersion | null,
  maxDocumentBytes: number,
  applyFaults: boolean,
  faults: LocalManagedOptions["faults"],
) {
  const pinned = await pinDocumentTarget(documentsRoot, handle.relativePath)
  const temporary = path.join(pinned.parent, `.${path.basename(pinned.target)}.${process.pid}.${crypto.randomUUID()}.tmp`)
  const claimedPath = path.join(pinned.parent, `.${path.basename(pinned.target)}.${process.pid}.${crypto.randomUUID()}.claim`)
  let claimed = false
  let installed = false
  let committed = false
  try {
    if (applyFaults) await faults?.beforeTempOpen?.()
    const file = await fs.open(temporary, "wx", 0o600)
    try {
      await file.writeFile(markdown)
      await file.sync()
    } finally {
      await file.close()
    }
    if (applyFaults) await faults?.beforeRename?.()
    if (applyFaults) await faults?.beforeAuthorityClaim?.({ target: pinned.target, parent: pinned.parent })
    await verifyPinnedParent(pinned)

    let claimedVersion: DocumentVersion | null = null
    let claimedIdentity: Readonly<{ dev: number; ino: number }> | undefined
    if (expectedVersion !== null) {
      await fs.rename(pinned.target, claimedPath).catch((error: unknown) => {
        if (nodeErrorCode(error) === "ENOENT") throw new DocumentVersionConflictError(null)
        throw error
      })
      claimed = true
      await verifyPinnedParent(pinned)
      const authority = await readPinnedFile(pinned, claimedPath, handle.documentId, maxDocumentBytes)
      claimedVersion = localDocumentVersion(authority.content, authority.stat)
      claimedIdentity = { dev: authority.stat.dev, ino: authority.stat.ino }
      if (!documentVersionsMatch(expectedVersion, claimedVersion)) throw new DocumentVersionConflictError(claimedVersion)
      if (applyFaults) {
        await faults?.afterAuthorityClaimed?.({ target: pinned.target, parent: pinned.parent, claimedPath })
      }
    } else if (await exists(pinned.target)) {
      throw new DocumentVersionConflictError(await currentVersion(pinned, maxDocumentBytes))
    }

    await verifyPinnedParent(pinned)
    await fs.link(temporary, pinned.target).catch(async (error: unknown) => {
      if (nodeErrorCode(error) === "EEXIST") {
        throw new DocumentVersionConflictError(await currentVersion(pinned, maxDocumentBytes))
      }
      throw error
    })
    installed = true
    if (applyFaults && claimed) {
      await faults?.afterReplacementInstalled?.({ target: pinned.target, parent: pinned.parent, claimedPath })
    }
    await verifyPinnedParent(pinned)
    await verifyInstalledTarget(pinned, temporary)

    if (claimed && claimedIdentity && claimedVersion) {
      // The claim keeps the old inode named while the replacement is linked.
      // Re-reading it here detects writers that retained an FD across rename.
      const revalidated = await readPinnedFile(pinned, claimedPath, handle.documentId, maxDocumentBytes)
      const revalidatedVersion = localDocumentVersion(revalidated.content, revalidated.stat)
      if (
        revalidated.stat.dev !== claimedIdentity.dev ||
        revalidated.stat.ino !== claimedIdentity.ino ||
        !documentVersionsMatch(claimedVersion, revalidatedVersion)
      ) {
        throw new DocumentVersionConflictError(revalidatedVersion)
      }
    }

    try {
      if (applyFaults) await faults?.beforeDirectoryFsync?.({ target: pinned.target, parent: pinned.parent })
      await syncDirectory(pinned.parent)
    } catch (error) {
      await rollbackInstalledAuthority(pinned, temporary, claimed ? claimedPath : undefined, maxDocumentBytes)
      installed = false
      claimed = false
      throw error
    }
    committed = true
    await cleanupCommittedReplacement(temporary, claimed ? claimedPath : undefined, pinned.parent)
  } catch (error) {
    let conflictVersion = error instanceof DocumentVersionConflictError ? error.currentVersion : undefined
    if (!committed && installed) {
      conflictVersion = await rollbackInstalledAuthority(
        pinned,
        temporary,
        claimed ? claimedPath : undefined,
        maxDocumentBytes,
      )
      installed = false
      claimed = false
    } else if (!committed && claimed) {
      conflictVersion = await restoreClaimedAuthority(pinned, claimedPath, maxDocumentBytes)
      claimed = false
    }
    await removeTemporaryTyped(temporary, handle.documentId)
    if (error instanceof DocumentVersionConflictError) throw new DocumentVersionConflictError(conflictVersion ?? null)
    if (committed) {
      console.warn(`[claxedo-server] committed document ${handle.documentId} but could not remove replacement artifacts`, error)
      return
    }
    throw documentErrorFromCause(error, `writing document ${handle.documentId}`, handle.documentId)
  } finally {
    await pinned.parentHandle.close().catch((error: unknown) => {
      console.warn(`[claxedo-server] failed to close document ${handle.documentId} parent handle`, error)
    })
  }
}

async function verifyInstalledTarget(pinned: PinnedTarget, temporary: string) {
  const [target, source] = await Promise.all([fs.stat(pinned.target), fs.stat(temporary)])
  if (target.dev !== source.dev || target.ino !== source.ino) {
    throw new DocumentVersionConflictError(null)
  }
}

async function rollbackInstalledAuthority(
  pinned: PinnedTarget,
  temporary: string,
  claimedPath: string | undefined,
  maxDocumentBytes: number,
) {
  await verifyPinnedParent(pinned)
  const [target, source] = await Promise.all([
    fs.stat(pinned.target).catch((error: unknown) => nodeErrorCode(error) === "ENOENT" ? undefined : Promise.reject(error)),
    fs.stat(temporary).catch((error: unknown) => nodeErrorCode(error) === "ENOENT" ? undefined : Promise.reject(error)),
  ])
  if (target && source && target.dev === source.dev && target.ino === source.ino) await fs.unlink(pinned.target)
  if (claimedPath && !(await exists(pinned.target))) {
    await fs.link(claimedPath, pinned.target).catch((error: unknown) => {
      if (nodeErrorCode(error) !== "EEXIST") throw error
    })
    if (await sameFile(claimedPath, pinned.target)) await removeIfPresent(claimedPath)
  }
  await syncDirectory(pinned.parent)
  await removeIfPresent(temporary)
  return await currentVersion(pinned, maxDocumentBytes)
}

async function restoreClaimedAuthority(pinned: PinnedTarget, claimedPath: string, maxDocumentBytes: number) {
  await verifyPinnedParent(pinned)
  if (!(await exists(pinned.target))) {
    await fs.link(claimedPath, pinned.target).catch((error: unknown) => {
      if (nodeErrorCode(error) !== "EEXIST") throw error
    })
    if (await sameFile(claimedPath, pinned.target)) await removeIfPresent(claimedPath)
    await syncDirectory(pinned.parent)
  }
  return await currentVersion(pinned, maxDocumentBytes)
}

async function currentVersion(pinned: PinnedTarget, maxDocumentBytes: number) {
  return await readPinnedFile(pinned, pinned.target, "current", maxDocumentBytes)
    .then((current) => localDocumentVersion(current.content, current.stat))
    .catch((error: unknown) => {
      if (error instanceof DocumentNotFoundError) return null
      throw error
    })
}

async function sameFile(left: string, right: string) {
  const [leftStat, rightStat] = await Promise.all([fs.stat(left), fs.stat(right)])
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino
}

async function cleanupCommittedReplacement(temporary: string, claimedPath: string | undefined, directory: string) {
  try {
    if (claimedPath) await removeIfPresent(claimedPath)
    await removeIfPresent(temporary)
    await syncDirectory(directory)
  } catch (error) {
    console.warn("[claxedo-server] document replacement committed with recoverable cleanup artifacts", error)
  }
}

async function removeTemporaryTyped(temporary: string, documentId: string) {
  await removeIfPresent(temporary).catch((error: unknown) => {
    throw documentErrorFromCause(error, `cleaning temporary file for document ${documentId}`)
  })
}

function expectedVersionMatches(expected: DocumentVersion | null, current: DocumentVersion | null) {
  if (expected === null || current === null) return expected === current
  return documentVersionsMatch(expected, current)
}

async function resolvePinnedPath(root: string, relativePath: string) {
  const realRoot = await fs.realpath(root).catch((error: unknown) => {
    throw documentErrorFromCause(error, "resolving the managed documents root")
  })
  const lexical = path.resolve(root, relativePath)
  if (!inside(path.resolve(root), lexical)) throw new DocumentPathError("Managed document path escapes its root")

  const existing = await nearestExistingPath(lexical).catch((error: unknown) => {
    if (error instanceof DocumentPathError) throw error
    throw documentErrorFromCause(error, "resolving a managed document path")
  })
  const realExisting = await fs.realpath(existing).catch((error: unknown) => {
    if (nodeErrorCode(error) === "ENOENT") throw new DocumentPathError("Managed document path contains a broken symlink", { cause: error })
    throw documentErrorFromCause(error, "resolving a managed document symlink")
  })
  if (!inside(realRoot, realExisting)) throw new DocumentPathError("Managed document symlink escapes its root")
  const resolved = path.resolve(realExisting, path.relative(existing, lexical))
  if (!inside(realRoot, resolved)) throw new DocumentPathError("Managed document path escapes its root")
  return resolved
}

async function nearestExistingPath(input: string): Promise<string> {
  const found = await fs.lstat(input).then(() => true, (error: unknown) => {
    if (nodeErrorCode(error) === "ENOENT") return false
    throw error
  })
  if (found) return input
  const parent = path.dirname(input)
  if (parent === input) throw new DocumentPathError("Managed document path has no existing root")
  return await nearestExistingPath(parent)
}

function inside(root: string, candidate: string) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

type LockMetadata = Readonly<{
  pid: number
  hostname: string
  token: string
  createdAt: number
  heartbeatAt: number
}>

async function withDocumentLock<T>(
  root: string,
  documentId: string,
  options: LocalManagedOptions["locking"],
  run: () => Promise<T>,
) {
  const directory = path.join(root, "document-history", documentId)
  const lock = path.join(directory, ".write.lock")
  const staleMs = options?.staleMs ?? LOCK_STALE_MS
  const waitMs = options?.waitMs ?? LOCK_WAIT_MS
  const heartbeatMs = options?.heartbeatMs ?? LOCK_HEARTBEAT_MS
  await fs.mkdir(directory, { recursive: true, mode: 0o700 }).catch((error: unknown) => {
    throw documentErrorFromCause(error, `creating lock directory for ${documentId}`)
  })
  const startedAt = Date.now()

  while (true) {
    const acquired = await fs.open(lock, "wx", 0o600).catch(async (error: unknown) => {
      if (nodeErrorCode(error) !== "EEXIST") throw documentErrorFromCause(error, `locking document ${documentId}`)
      await reclaimCrashedLock(lock, staleMs, documentId)
      return undefined
    })
    if (acquired) {
      const metadata: LockMetadata = {
        pid: process.pid,
        hostname: os.hostname(),
        token: crypto.randomUUID(),
        createdAt: Date.now(),
        heartbeatAt: Date.now(),
      }
      try {
        await acquired.writeFile(JSON.stringify(metadata))
        await acquired.sync()
        let heartbeatWrite = Promise.resolve()
        const heartbeat = setInterval(() => {
          heartbeatWrite = heartbeatWrite.then(() => writeLockHeartbeat(acquired, metadata)).catch((error: unknown) => {
            console.warn(`[claxedo-server] document ${documentId} lock heartbeat failed`, error)
          })
        }, heartbeatMs)
        heartbeat.unref()
        try {
          return await run()
        } finally {
          clearInterval(heartbeat)
          await heartbeatWrite
          await releaseOwnedLock(lock, acquired, metadata.token, documentId).catch((error: unknown) => {
            console.warn(`[claxedo-server] failed to release document ${documentId} lock`, error)
          })
        }
      } finally {
        await acquired.close()
      }
    }
    if (Date.now() - startedAt >= waitMs) throw new DocumentLockTimeoutError(documentId)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function writeLockHeartbeat(handle: FileHandle, metadata: LockMetadata) {
  const content = Buffer.from(JSON.stringify({ ...metadata, heartbeatAt: Date.now() }))
  await handle.truncate(0)
  await handle.write(content, 0, content.byteLength, 0)
  await handle.sync()
}

async function reclaimCrashedLock(lock: string, staleMs: number, documentId: string) {
  const inspected = await inspectLock(lock, documentId)
  if (!inspected || inspected.stat.mtimeMs >= Date.now() - staleMs) return
  if (
    inspected.metadata?.hostname === os.hostname() &&
    processIsAlive(inspected.metadata.pid)
  ) return

  const reclaimed = `${lock}.${process.pid}.${crypto.randomUUID()}.reclaim`
  await fs.rename(lock, reclaimed).catch((error: unknown) => {
    if (nodeErrorCode(error) !== "ENOENT") throw documentErrorFromCause(error, `claiming stale lock for ${documentId}`)
  })
  if (!(await exists(reclaimed))) return
  const claimed = await inspectLock(reclaimed, documentId)
  if (
    claimed &&
    claimed.stat.dev === inspected.stat.dev &&
    claimed.stat.ino === inspected.stat.ino &&
    claimed.metadata?.token === inspected.metadata?.token
  ) {
    await removeIfPresent(reclaimed).catch((error: unknown) => {
      throw documentErrorFromCause(error, `removing stale lock for ${documentId}`)
    })
    return
  }

  await fs.link(reclaimed, lock).catch((error: unknown) => {
    if (nodeErrorCode(error) !== "EEXIST") throw documentErrorFromCause(error, `restoring lock for ${documentId}`)
  })
  if (await exists(lock).then(async (present) => present && await sameFile(lock, reclaimed))) await removeIfPresent(reclaimed)
}

async function inspectLock(lock: string, documentId: string) {
  const stat = await fs.stat(lock).catch((error: unknown) => {
    if (nodeErrorCode(error) === "ENOENT") return undefined
    throw documentErrorFromCause(error, `inspecting lock for ${documentId}`)
  })
  if (!stat) return undefined
  const raw = await fs.readFile(lock, "utf8").catch((error: unknown) => {
    if (nodeErrorCode(error) === "ENOENT") return undefined
    throw documentErrorFromCause(error, `reading lock for ${documentId}`)
  })
  if (raw === undefined) return undefined
  return { stat, metadata: parseLockMetadata(raw) }
}

function parseLockMetadata(raw: string): LockMetadata | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== "object") return undefined
    if (!("pid" in value) || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid < 1) return undefined
    if (!("hostname" in value) || typeof value.hostname !== "string" || !value.hostname) return undefined
    if (!("token" in value) || typeof value.token !== "string" || !value.token) return undefined
    if (!("createdAt" in value) || typeof value.createdAt !== "number") return undefined
    if (!("heartbeatAt" in value) || typeof value.heartbeatAt !== "number") return undefined
    return {
      pid: value.pid,
      hostname: value.hostname,
      token: value.token,
      createdAt: value.createdAt,
      heartbeatAt: value.heartbeatAt,
    }
  } catch {
    return undefined
  }
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return nodeErrorCode(error) !== "ESRCH"
  }
}

async function releaseOwnedLock(lock: string, handle: FileHandle, token: string, documentId: string) {
  const release = `${lock}.${process.pid}.${crypto.randomUUID()}.release`
  await fs.rename(lock, release).catch((error: unknown) => {
    if (nodeErrorCode(error) !== "ENOENT") throw documentErrorFromCause(error, `claiming lock release for ${documentId}`)
  })
  if (!(await exists(release))) return
  const [releasedStat, handleStat, metadata] = await Promise.all([
    fs.stat(release),
    handle.stat(),
    fs.readFile(release, "utf8").then(parseLockMetadata),
  ])
  if (releasedStat.dev === handleStat.dev && releasedStat.ino === handleStat.ino && metadata?.token === token) {
    await removeIfPresent(release).catch((error: unknown) => {
      throw documentErrorFromCause(error, `releasing lock for ${documentId}`)
    })
    return
  }
  await fs.link(release, lock).catch((error: unknown) => {
    if (nodeErrorCode(error) !== "EEXIST") throw documentErrorFromCause(error, `restoring lock during release for ${documentId}`)
  })
  if (await exists(lock).then(async (present) => present && await sameFile(lock, release))) await removeIfPresent(release)
}

async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, "r")
  try {
    await handle.sync()
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EBADF", "EISDIR"].includes(nodeErrorCode(error) ?? "")) throw error
  } finally {
    await handle.close()
  }
}

async function exists(file: string) {
  return await fs.lstat(file).then(() => true, (error: unknown) => {
    if (nodeErrorCode(error) === "ENOENT") return false
    throw error
  })
}

async function removeIfPresent(file: string) {
  await fs.unlink(file).catch((error: unknown) => {
    if (nodeErrorCode(error) !== "ENOENT") throw error
  })
}
