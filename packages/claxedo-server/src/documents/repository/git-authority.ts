import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import {
  DocumentInvalidEntryError,
  DocumentPathError,
  DocumentSnapshotCorruptError,
  DocumentSnapshotNotFoundError,
  DocumentVersionConflictError,
  nodeErrorCode,
} from "../errors"
import type { DocumentActor, SnapshotID, SnapshotRef, SnapshotRequest } from "../port"
import {
  atomicRepositoryReplace,
  insideRepository,
  normalizeRepositoryRelativePath,
  readRepositoryFile,
  serializeRepositoryOperation,
  syncDirectory,
} from "./file-authority"
import { mapBounded } from "../map-bounded"
import {
  boundedSnapshotPins,
  expiredSnapshotLease,
  MAX_SNAPSHOT_METADATA_BYTES,
  requireBoundedSnapshotMetadata,
} from "../snapshot-pins"
import { contentHash } from "../version"
import { BoundedFileTooLargeError, readBoundedFile } from "../bounded-file-read"

const DEFAULT_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_SNAPSHOTS = 50
const DEFAULT_MAX_SNAPSHOT_AGE_MS = 30 * 24 * 60 * 60 * 1_000
const commitQueues = new Map<string, Promise<void>>()

export type RepositoryGitSnapshot = Readonly<{
  repoRoot: string
  head: string
  branch: string
  blobSha: string
  tracked: boolean
  dirty: boolean
}>

export type RepositoryCommitRequest = Readonly<{
  markdown: string
  message: string
  expected: Readonly<{ baseCommit?: string; baseBlobSha?: string }>
}>

export class RepositoryGitConflictError extends Error {
  readonly code = "git_source_conflict"

  constructor(
    message: string,
    readonly evidence: Readonly<{
      currentCommit: string
      currentBlobSha: string
      dirty: boolean
    }>,
  ) {
    super(message)
    this.name = "RepositoryGitConflictError"
  }
}

export type RepositoryGitAuthority = Readonly<{
  inspect(root: string, relativePath: string): Promise<RepositoryGitSnapshot>
  commit(
    root: string,
    relativePath: string,
    request: RepositoryCommitRequest,
  ): Promise<Readonly<{ commit: string; blobSha: string }>>
  capture(root: string, documentId: string, markdown: string, request: SnapshotRequest): Promise<SnapshotRef>
  list(root: string, documentId: string): Promise<SnapshotRef[]>
  read(
    root: string,
    documentId: string,
    snapshotId: SnapshotID,
  ): Promise<Readonly<{ markdown: string; snapshot: SnapshotRef }>>
  pin(root: string, documentId: string, snapshotId: SnapshotID, pin: string): Promise<SnapshotRef>
  unpin(root: string, documentId: string, snapshotId: SnapshotID, pin: string): Promise<SnapshotRef>
  collect(root: string, documentId: string): Promise<void>
}>

export type RepositoryGitRun = (
  args: readonly string[],
  directory: string,
  options?: Readonly<{ env?: Readonly<Record<string, string>> }>,
) => Promise<string>

export type LocalRepositoryGitAuthorityOptions = Readonly<{
  now?: () => number
  maxSnapshots?: number
  maxSnapshotAgeMs?: number
  faults?: Readonly<{
    afterContentInstalled?: (input: Readonly<{ target: string }>) => void | Promise<void>
    afterTemporaryIndexAdd?: (input: Readonly<{ target: string }>) => void | Promise<void>
    beforeHeadUpdate?: (input: Readonly<{ repoRoot: string; expectedHead: string }>) => void | Promise<void>
    afterHeadUpdate?: (input: Readonly<{ target: string; commit: string }>) => void | Promise<void>
    afterSnapshotMetadataRemoved?: (snapshotId: SnapshotID) => void | Promise<void>
    beforeSnapshotMetadataRead?: (snapshotId: SnapshotID) => void | Promise<void>
    beforeSnapshotContentWrite?: (snapshotId: SnapshotID) => void | Promise<void>
  }>
}>

export function createLocalRepositoryGitAuthority(
  runGit: RepositoryGitRun,
  options: LocalRepositoryGitAuthorityOptions = {},
): RepositoryGitAuthority {
  const now = options.now ?? Date.now
  const maxSnapshots = options.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS
  const maxSnapshotAgeMs = options.maxSnapshotAgeMs ?? DEFAULT_MAX_SNAPSHOT_AGE_MS
  if (!Number.isSafeInteger(maxSnapshots) || maxSnapshots < 1) {
    throw new DocumentInvalidEntryError("Repository snapshot retention must keep at least one unpinned snapshot")
  }
  if (!Number.isFinite(maxSnapshotAgeMs) || maxSnapshotAgeMs < 0) {
    throw new DocumentInvalidEntryError("Repository snapshot retention age must be non-negative")
  }
  return {
    inspect,

    async commit(root, relativePath, request) {
      const initial = await inspect(root, relativePath)
      return await serializeRepositoryOperation(commitQueues, initial.repoRoot, async () => {
        if (!request.message.trim()) throw new DocumentInvalidEntryError("Git commit message is required")
        const before = await inspect(root, relativePath)
        requireGitBase(before, request.expected, false)
        const target = await fs.realpath(path.join(root, normalizeRepositoryRelativePath(relativePath)))
        const repositoryRelativePath = path.relative(before.repoRoot, target)
        const current = await readRepositoryFile("git-commit", target, DEFAULT_MAX_DOCUMENT_BYTES)
        const temporaryIndex = path.join(
          path.resolve(before.repoRoot, (await runGit(["rev-parse", "--git-dir"], before.repoRoot)).trim()),
          `claxedo-index-${crypto.randomUUID()}`,
        )
        const temporaryContent = `${temporaryIndex}.content`
        const environment = { GIT_INDEX_FILE: temporaryIndex }
        let headUpdated = false
        try {
          await replaceSnapshotFile(temporaryContent, request.markdown, 0o600)
          await atomicRepositoryReplace(
            before.repoRoot,
            "git-commit",
            target,
            request.markdown,
            current.version,
            DEFAULT_MAX_DOCUMENT_BYTES,
            undefined,
          )
          await options.faults?.afterContentInstalled?.({ target })
          requireGitBase(await inspect(root, relativePath), request.expected, true)
          await runGit(["read-tree", request.expected.baseCommit!], before.repoRoot, { env: environment })
          await runGit(["add", "--", repositoryRelativePath], before.repoRoot, { env: environment })
          await options.faults?.afterTemporaryIndexAdd?.({ target })
          await requireWorktreeContent(target, request.markdown, () => inspect(root, relativePath))
          const staged = (
            await runGit(["ls-files", "-s", "--", repositoryRelativePath], before.repoRoot, { env: environment })
          ).trim()
          const stagedBlob = staged.match(/^\d+\s+([0-9a-f]{40,64})\s+/)?.[1]
          const requestedBlob = (await runGit(["hash-object", temporaryContent], before.repoRoot)).trim()
          if (!stagedBlob || stagedBlob !== requestedBlob)
            throw repositoryGitConflict(await inspect(root, relativePath))
          const tree = (await runGit(["write-tree"], before.repoRoot, { env: environment })).trim()
          const commit = (
            await runGit(
              ["commit-tree", tree, "-p", request.expected.baseCommit!, "-m", request.message],
              before.repoRoot,
            )
          ).trim()
          requireGitBase(await inspect(root, relativePath), request.expected, true)
          await options.faults?.beforeHeadUpdate?.({
            repoRoot: before.repoRoot,
            expectedHead: request.expected.baseCommit!,
          })
          await requireWorktreeContent(target, request.markdown, () => inspect(root, relativePath))
          requireGitBase(await inspect(root, relativePath), request.expected, true)
          await runGit(["update-ref", "HEAD", commit, request.expected.baseCommit!], before.repoRoot).catch(
            async () => {
              throw repositoryGitConflict(await inspect(root, relativePath))
            },
          )
          headUpdated = true
          await options.faults?.afterHeadUpdate?.({ target, commit })
          await runGit(["reset", commit, "--", repositoryRelativePath], before.repoRoot)
          const after = await inspect(root, relativePath)
          if (after.head !== commit) throw repositoryGitConflict(after)
          return { commit, blobSha: after.blobSha }
        } catch (error) {
          if (!headUpdated) {
            const installed = await readRepositoryFile("git-rollback", target, DEFAULT_MAX_DOCUMENT_BYTES).catch(
              () => undefined,
            )
            if (installed && contentHash(installed.markdown) === contentHash(request.markdown)) {
              await atomicRepositoryReplace(
                before.repoRoot,
                "git-rollback",
                target,
                current.markdown,
                installed.version,
                DEFAULT_MAX_DOCUMENT_BYTES,
                undefined,
              ).catch((rollbackError: unknown) => {
                if (!(rollbackError instanceof DocumentVersionConflictError)) throw rollbackError
              })
            }
          }
          throw error
        } finally {
          await Promise.all([fs.rm(temporaryIndex, { force: true }), fs.rm(temporaryContent, { force: true })]).catch(
            () => undefined,
          )
        }
      })
    },

    async capture(root, documentId, markdown, request) {
      if (!request.reason.trim()) throw new DocumentInvalidEntryError("Snapshot reason is required")
      if (!request.actor.id.trim()) throw new DocumentInvalidEntryError("Snapshot actor id is required")
      const id = contentHash(markdown) as SnapshotID
      const directory = await snapshotDirectory(root, documentId)
      return await serializeRepositoryOperation(commitQueues, `${directory}\0snapshots`, async () => {
        const existing = await readSnapshotMetadata(directory, id).catch((error: unknown) => {
          if (error instanceof DocumentSnapshotNotFoundError) return undefined
          throw error
        })
        const content = await readSnapshotContent(directory, id).catch((error: unknown) => {
          if (
            error instanceof DocumentSnapshotNotFoundError ||
            error instanceof DocumentSnapshotCorruptError
          ) {
            return undefined
          }
          throw error
        })
        if (existing && content && contentHash(content.markdown) === id) return existing
        const latest = (await listSnapshots(root, documentId))[0]
        const snapshot: SnapshotRef = existing ?? {
          id,
          sha256: id,
          size: Buffer.byteLength(markdown),
          reason: request.reason,
          actor: request.actor,
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
          createdAt: Math.max(now(), (latest?.createdAt ?? 0) + 1),
          pins: [],
        }
        await fs.mkdir(directory, { recursive: true, mode: 0o700 })
        await options.faults?.beforeSnapshotContentWrite?.(id)
        await replaceSnapshotFile(path.join(directory, `${id}.md`), markdown, 0o400)
        await replaceSnapshotFile(path.join(directory, `${id}.json`), requireBoundedSnapshotMetadata(snapshot), 0o600)
        await collectSnapshotsUnlocked(root, documentId)
        return snapshot
      })
    },

    list: listSnapshots,

    async read(root, documentId, snapshotId) {
      const directory = await snapshotDirectory(root, documentId)
      const snapshot = await readSnapshotMetadata(directory, snapshotId)
      const current = await readSnapshotContent(directory, snapshotId)
      if (current.content.byteLength !== snapshot.size || contentHash(current.content) !== snapshot.sha256) {
        throw new DocumentSnapshotCorruptError(snapshotId)
      }
      return { markdown: current.markdown, snapshot }
    },

    async pin(root, documentId, snapshotId, pin) {
      if (!pin.trim()) throw new DocumentInvalidEntryError("Snapshot pin is required")
      return await updatePins(root, documentId, snapshotId, (pins) => [...pins, pin])
    },

    async unpin(root, documentId, snapshotId, pin) {
      return await updatePins(root, documentId, snapshotId, (pins) => pins.filter((candidate) => candidate !== pin))
    },

    async collect(root, documentId) {
      const directory = await snapshotDirectory(root, documentId)
      await serializeRepositoryOperation(commitQueues, `${directory}\0snapshots`, () =>
        collectSnapshotsUnlocked(root, documentId),
      )
    },
  }

  async function inspect(root: string, relativePath: string): Promise<RepositoryGitSnapshot> {
    const repoRoot = await fs.realpath((await runGit(["rev-parse", "--show-toplevel"], root)).trim())
    const target = await fs.realpath(path.join(root, normalizeRepositoryRelativePath(relativePath)))
    if (!insideRepository(repoRoot, target))
      throw new DocumentPathError("Repository document path is outside the Git repository")
    const repositoryRelativePath = path.relative(repoRoot, target)
    const tree = (await runGit(["ls-tree", "HEAD", "--", repositoryRelativePath], repoRoot)).trim()
    const blobSha = tree.match(/\sblob\s+([0-9a-f]{40,64})\s/)?.[1] ?? ""
    return {
      repoRoot,
      head: (await runGit(["rev-parse", "HEAD"], repoRoot)).trim(),
      branch: (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot)).trim(),
      blobSha,
      tracked: Boolean(blobSha),
      dirty: Boolean((await runGit(["status", "--porcelain", "--", repositoryRelativePath], repoRoot)).trim()),
    }
  }

  async function updatePins(
    root: string,
    documentId: string,
    snapshotId: SnapshotID,
    update: (pins: readonly string[]) => readonly string[],
  ) {
    const directory = await snapshotDirectory(root, documentId)
    return await serializeRepositoryOperation(commitQueues, `${directory}\0snapshots`, async () => {
      const snapshot = await readSnapshotMetadata(directory, snapshotId)
      const updated = { ...snapshot, pins: boundedSnapshotPins(update(snapshot.pins), now()) }
      await replaceSnapshotFile(
        path.join(directory, `${snapshotId}.json`),
        requireBoundedSnapshotMetadata(updated),
        0o600,
      )
      return updated
    })
  }

  async function listSnapshots(root: string, documentId: string) {
    const directory = await snapshotDirectory(root, documentId)
    const names = await fs.readdir(directory).catch((error: unknown) => {
      if (nodeErrorCode(error) === "ENOENT") return []
      throw error
    })
    return (
      await mapBounded(
        names.filter((name) => name.endsWith(".json")),
        (name) => {
          const snapshotId = name.slice(0, -5) as SnapshotID
          return Promise.resolve(options.faults?.beforeSnapshotMetadataRead?.(snapshotId)).then(() =>
            readSnapshotMetadata(directory, snapshotId).catch((error: unknown) => {
              if (error instanceof DocumentSnapshotNotFoundError) return undefined
              throw error
            }),
          )
        },
      )
    )
      .filter((snapshot): snapshot is SnapshotRef => Boolean(snapshot))
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
  }

  async function collectSnapshotsUnlocked(root: string, documentId: string) {
    const snapshots = await listSnapshots(root, documentId)
    const directory = await snapshotDirectory(root, documentId)
    const pruned = await snapshots.reduce(async (previous, snapshot) => {
      const values = await previous
      const pins = boundedSnapshotPins(snapshot.pins, now())
      const updated = { ...snapshot, pins }
      if (pins.length !== snapshot.pins.length || pins.some((pin, index) => pin !== snapshot.pins[index])) {
        await replaceSnapshotFile(
          path.join(directory, `${snapshot.id}.json`),
          requireBoundedSnapshotMetadata(updated),
          0o600,
        )
      }
      return [...values, updated]
    }, Promise.resolve([] as SnapshotRef[]))
    const unpinned = pruned.filter((snapshot) => snapshot.pins.every((pin) => expiredSnapshotLease(pin, now())))
    const expiredBefore = now() - maxSnapshotAgeMs
    const expired = unpinned.filter(
      (snapshot, index) => index >= maxSnapshots || (index > 0 && snapshot.createdAt < expiredBefore),
    )
    await expired.reduce(async (previous, snapshot) => {
      await previous
      await fs.rm(path.join(directory, `${snapshot.id}.json`), { force: true })
      await syncDirectory(directory)
      await options.faults?.afterSnapshotMetadataRemoved?.(snapshot.id)
      await fs.rm(path.join(directory, `${snapshot.id}.md`), { force: true })
      await syncDirectory(directory)
    }, Promise.resolve())

    const names = await fs.readdir(directory).catch((error: unknown) => {
      if (nodeErrorCode(error) === "ENOENT") return []
      throw error
    })
    const metadata = new Set(names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)))
    await Promise.all(
      names
        .filter((name) => name.endsWith(".md") && !metadata.has(name.slice(0, -3)))
        .map((name) => fs.rm(path.join(directory, name), { force: true })),
    )
    if (names.length) await syncDirectory(directory)
  }

  async function snapshotDirectory(root: string, documentId: string) {
    const gitDirectory = (await runGit(["rev-parse", "--git-dir"], root)).trim()
    return path.join(path.resolve(root, gitDirectory), "claxedo-document-snapshots", encodeURIComponent(documentId))
  }
}

export function repositoryGitConflict(snapshot: RepositoryGitSnapshot) {
  return new RepositoryGitConflictError(
    snapshot.dirty ? "source file is dirty" : snapshot.tracked ? "source base changed" : "source file is untracked",
    {
      currentCommit: snapshot.head,
      currentBlobSha: snapshot.blobSha,
      dirty: snapshot.dirty,
    },
  )
}

function requireGitBase(
  snapshot: RepositoryGitSnapshot,
  expected: RepositoryCommitRequest["expected"],
  allowDirty: boolean,
) {
  if (
    (!allowDirty && snapshot.dirty) ||
    !snapshot.tracked ||
    !snapshot.blobSha ||
    snapshot.blobSha !== expected.baseBlobSha ||
    snapshot.head !== expected.baseCommit
  ) {
    throw repositoryGitConflict(snapshot)
  }
}

async function requireWorktreeContent(target: string, markdown: string, inspect: () => Promise<RepositoryGitSnapshot>) {
  const current = await readRepositoryFile("git-commit", target, DEFAULT_MAX_DOCUMENT_BYTES)
  if (contentHash(current.markdown) !== contentHash(markdown)) {
    throw repositoryGitConflict(await inspect())
  }
}

async function readSnapshotMetadata(directory: string, snapshotId: SnapshotID) {
  const raw = await readBoundedSnapshotMetadata(path.join(directory, `${snapshotId}.json`), snapshotId)
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw))
    const snapshot = snapshotRef(value, snapshotId)
    if (!snapshot) throw new Error("Invalid repository snapshot metadata")
    return snapshot
  } catch (error) {
    if (error instanceof DocumentSnapshotCorruptError) throw error
    throw new DocumentSnapshotCorruptError(snapshotId, { cause: error })
  }
}

async function readSnapshotContent(directory: string, snapshotId: SnapshotID) {
  const target = path.join(directory, `${snapshotId}.md`)
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
    if (nodeErrorCode(error) === "ENOENT") throw new DocumentSnapshotNotFoundError(snapshotId, { cause: error })
    throw new DocumentSnapshotCorruptError(snapshotId, { cause: error })
  })
  const current = await readBoundedFile(handle, DEFAULT_MAX_DOCUMENT_BYTES)
    .catch((error: unknown) => {
      if (error instanceof BoundedFileTooLargeError) throw new DocumentSnapshotCorruptError(snapshotId)
      throw error
    })
    .finally(() => handle.close())
  const pathStat = await fs.stat(target).catch(() => undefined)
  if (
    !current.before.isFile() ||
    current.before.dev !== current.after.dev ||
    current.before.ino !== current.after.ino ||
    current.before.size !== current.after.size ||
    current.before.mtimeMs !== current.after.mtimeMs ||
    !pathStat ||
    pathStat.dev !== current.after.dev ||
    pathStat.ino !== current.after.ino
  ) {
    throw new DocumentSnapshotCorruptError(snapshotId)
  }
  try {
    const markdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(current.content)
    if (markdown.includes("\0")) throw new Error("NUL byte")
    return { markdown, content: current.content }
  } catch (error) {
    throw new DocumentSnapshotCorruptError(snapshotId, { cause: error })
  }
}

async function readBoundedSnapshotMetadata(file: string, snapshotId: SnapshotID) {
  const handle = await fs.open(file, "r").catch((error: unknown) => {
    if (nodeErrorCode(error) === "ENOENT") throw new DocumentSnapshotNotFoundError(snapshotId, { cause: error })
    throw error
  })
  try {
    const { before, content, after } = await readBoundedFile(handle, MAX_SNAPSHOT_METADATA_BYTES).catch(
      (error: unknown) => {
        if (error instanceof BoundedFileTooLargeError) throw new DocumentSnapshotCorruptError(snapshotId)
        throw error
      },
    )
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new DocumentSnapshotCorruptError(snapshotId)
    }
    return content
  } finally {
    await handle.close()
  }
}

function snapshotRef(value: unknown, snapshotId: SnapshotID): SnapshotRef | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const record = value as Record<string, unknown>
  if (record.id !== snapshotId || typeof record.id !== "string" || !/^[a-f0-9]{64}$/.test(record.id)) return
  if (record.sha256 !== snapshotId || typeof record.sha256 !== "string") return
  if (
    typeof record.size !== "number" ||
    !Number.isSafeInteger(record.size) ||
    record.size < 0 ||
    record.size > DEFAULT_MAX_DOCUMENT_BYTES
  ) return
  if (typeof record.reason !== "string" || !record.reason.trim()) return
  if (!snapshotActor(record.actor)) return
  if (
    typeof record.createdAt !== "number" ||
    !Number.isSafeInteger(record.createdAt) ||
    record.createdAt < 0 ||
    !Number.isFinite(new Date(record.createdAt).getTime())
  ) return
  if (!Array.isArray(record.pins) || !record.pins.every((pin) => typeof pin === "string")) return
  if (record.sessionId !== undefined && (typeof record.sessionId !== "string" || !record.sessionId.trim())) return
  const pinValues = record.pins as string[]

  try {
    const pins = boundedSnapshotPins(pinValues, Number.NEGATIVE_INFINITY)
    if (pins.length !== pinValues.length || pins.some((pin, index) => pin !== pinValues[index])) return
    return {
      id: record.id as SnapshotID,
      sha256: record.sha256,
      size: record.size,
      reason: record.reason,
      actor: record.actor,
      ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
      createdAt: record.createdAt,
      pins,
    }
  } catch {
    return
  }
}

function snapshotActor(value: unknown): value is DocumentActor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  if (!("type" in value) || !["user", "agent", "system"].includes(String(value.type))) return false
  return "id" in value && typeof value.id === "string" && Boolean(value.id.trim())
}

async function replaceSnapshotFile(target: string, content: string | Uint8Array, mode: number) {
  const temporary = `${target}.${crypto.randomUUID()}.tmp`
  try {
    const file = await fs.open(temporary, "wx", mode)
    try {
      await file.writeFile(content)
      await file.sync()
    } finally {
      await file.close()
    }
    await fs.rename(temporary, target)
    const directory = await fs.open(path.dirname(target), "r")
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}
