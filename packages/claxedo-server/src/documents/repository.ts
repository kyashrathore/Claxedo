import fs from "node:fs/promises"
import {
  DocumentInvalidEntryError,
  DocumentNotFoundError,
  DocumentVersionConflictError,
  documentErrorFromCause,
  nodeErrorCode,
} from "./errors"
import type { DocumentEntry, DocumentHandle, DocumentVersion, DocumentWorkspace, SnapshotRef } from "./port"
import { createLocalRepositoryFileAuthority, normalizeRepositoryRelativePath } from "./repository-file-authority"
import type {
  LocalRepositoryFileAuthorityOptions,
  RepositoryDocumentRead,
  RepositoryFileAuthority,
} from "./repository-file-authority"
import {
  createLocalRepositoryGitAuthority,
  RepositoryGitConflictError,
  repositoryGitConflict,
} from "./repository-git-authority"
import type {
  LocalRepositoryGitAuthorityOptions,
  RepositoryCommitRequest,
  RepositoryGitAuthority,
  RepositoryGitRun,
  RepositoryGitSnapshot,
} from "./repository-git-authority"
import { documentVersionsMatch, localDocumentVersion } from "./version"

export { createLocalRepositoryFileAuthority, createLocalRepositoryGitAuthority, RepositoryGitConflictError }
export type {
  LocalRepositoryFileAuthorityOptions,
  LocalRepositoryGitAuthorityOptions,
  RepositoryDocumentRead,
  RepositoryFileAuthority,
  RepositoryGitAuthority,
  RepositoryGitRun,
  RepositoryGitSnapshot,
  RepositoryCommitRequest,
}

const DEFAULT_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024

export type RepositoryDocumentHandle = DocumentHandle &
  Readonly<{
    origin: "repository"
    placement: "local"
    workspaceId: string
    relativePath: string
    canonicalPath: string
  }>

export type RepositoryAvailability =
  | Readonly<{ state: "available"; version: DocumentVersion; sourceHint?: "merge-conflict-markers" }>
  | Readonly<{ state: "missing" }>
  | Readonly<{ state: "moved"; relativePath: string }>
  | Readonly<{ state: "workspace-unavailable" }>

export class RepositoryUnavailableError extends Error {
  readonly code = "document_workspace_unavailable"
  readonly state = "workspace-unavailable"

  constructor(workspaceId: string, options?: ErrorOptions) {
    super(`Workspace ${workspaceId} is unavailable`, options)
    this.name = "RepositoryUnavailableError"
  }
}

export type RepositoryWorkspaceAuthority = Readonly<{
  resolve(workspaceId: string): Promise<Readonly<{ directory: string }> | undefined>
}>

export type RepositoryDocumentWorkspace = DocumentWorkspace<RepositoryDocumentHandle> &
  Readonly<{
    read(handle: RepositoryDocumentHandle): Promise<RepositoryDocumentRead>
    availability(entry: DocumentEntry, expectedVersion?: DocumentVersion): Promise<RepositoryAvailability>
    relocate(
      entry: DocumentEntry,
      relativePath: string,
      expectedVersion: DocumentVersion,
    ): Promise<RepositoryDocumentHandle>
    identityKey(entry: DocumentEntry): Promise<string>
    gitSnapshot(handle: RepositoryDocumentHandle): Promise<RepositoryGitSnapshot>
    commit(
      handle: RepositoryDocumentHandle,
      request: RepositoryCommitRequest,
    ): Promise<Readonly<{ commit: string; blobSha: string }>>
  }>

export function createRepositoryDocumentWorkspace(
  options: Readonly<{
    workspace: RepositoryWorkspaceAuthority
    files: RepositoryFileAuthority
    git: RepositoryGitAuthority
    maxDocumentBytes?: number
  }>,
): RepositoryDocumentWorkspace {
  const maxDocumentBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES

  return {
    resolve,

    async read(handle) {
      return await options.files.read(handle.documentId, (await target(handle)).canonicalPath, maxDocumentBytes)
    },

    async write(handle, request) {
      const resolved = await target(handle)
      const read = await options.files.compareAndSwap(
        resolved.root,
        handle.documentId,
        resolved.canonicalPath,
        request.markdown,
        request.expectedVersion,
        maxDocumentBytes,
      )
      const snapshot = await advisoryCapture(() => options.git.capture(resolved.root, handle.documentId, read.markdown, {
        reason: "document.written",
        actor: request.actor,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      }), handle.documentId)
      return { ...read, ...(snapshot ? { snapshot } : {}) }
    },

    async snapshot(handle, request) {
      const resolved = await target(handle)
      return await options.git.capture(
        resolved.root,
        handle.documentId,
        (await options.files.read(handle.documentId, resolved.canonicalPath, maxDocumentBytes)).markdown,
        request,
      )
    },

    async listSnapshots(handle) {
      return await options.git.list((await target(handle)).root, handle.documentId)
    },

    async readSnapshot(handle, snapshotId) {
      const resolved = await target(handle)
      const value = await options.git.read(resolved.root, handle.documentId, snapshotId)
      const bytes = Buffer.from(value.markdown)
      return {
        markdown: value.markdown,
        version: localDocumentVersion(bytes, { size: bytes.byteLength, mtimeMs: value.snapshot.createdAt }),
        modifiedAt: value.snapshot.createdAt,
      }
    },

    async restore(handle, snapshotId, request) {
      const resolved = await target(handle)
      const desired = await options.git.read(resolved.root, handle.documentId, snapshotId)
      const read = await options.files.compareAndSwap(
        resolved.root,
        handle.documentId,
        resolved.canonicalPath,
        desired.markdown,
        request.expectedVersion,
        maxDocumentBytes,
      )
      const snapshot = await advisoryCapture(() => options.git.capture(resolved.root, handle.documentId, read.markdown, {
        reason: `document.restored:${snapshotId}`,
        actor: request.actor,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      }), handle.documentId)
      return { ...read, ...(snapshot ? { snapshot } : {}) }
    },

    async pinSnapshot(handle, snapshotId, pin) {
      return await options.git.pin((await target(handle)).root, handle.documentId, snapshotId, pin)
    },

    async unpinSnapshot(handle, snapshotId, pin) {
      return await options.git.unpin((await target(handle)).root, handle.documentId, snapshotId, pin)
    },

    async collectSnapshots(handle) {
      await options.git.collect((await target(handle)).root, handle.documentId)
    },

    async availability(entry, expectedVersion) {
      const value = repositoryEntry(entry)
      const workspace = await resolveWorkspace(value)
      if (!workspace) return { state: "workspace-unavailable" }
      const canonicalPath = await options.files.resolve(workspace.root, value.relativePath).catch((error: unknown) => {
        if (nodeErrorCode(error) === "ENOENT") return undefined
        throw error
      })
      if (!canonicalPath) return { state: "workspace-unavailable" }
      const current = await options.files
        .read(value.documentId, canonicalPath, maxDocumentBytes)
        .catch((error: unknown) => {
          if (error instanceof DocumentNotFoundError) return undefined
          throw error
        })
      if (current) {
        return {
          state: "available",
          version: current.version,
          ...(current.sourceHint ? { sourceHint: current.sourceHint } : {}),
        }
      }
      if (!expectedVersion) return { state: "missing" }
      const moved = await options.files.findByVersion(workspace.root, expectedVersion, maxDocumentBytes)
      return moved ? { state: "moved", relativePath: moved } : { state: "missing" }
    },

    async relocate(entry, relativePath, expectedVersion) {
      const handle = await resolve({ ...repositoryEntry(entry), relativePath })
      const current = await options.files.read(handle.documentId, handle.canonicalPath, maxDocumentBytes)
      if (!documentVersionsMatch(expectedVersion, current.version)) {
        throw new DocumentVersionConflictError(current.version)
      }
      return handle
    },

    async identityKey(entry) {
      const value = repositoryEntry(entry)
      const workspace = await resolveWorkspace(value)
      if (!workspace) throw new RepositoryUnavailableError(value.workspaceId)
      return `${value.projectId}\0${await options.files.canonicalIdentity(workspace.root, value.relativePath)}`
    },

    async gitSnapshot(handle) {
      const resolved = await target(handle)
      const snapshot = await options.git.inspect(resolved.root, handle.relativePath)
      if (!snapshot.tracked || snapshot.dirty) throw repositoryGitConflict(snapshot)
      return snapshot
    },

    async commit(handle, request) {
      const resolved = await target(handle)
      return await options.git.commit(resolved.root, handle.relativePath, request)
    },
  }

  async function resolve(entry: DocumentEntry): Promise<RepositoryDocumentHandle> {
    const value = repositoryEntry(entry)
    const workspace = await resolveWorkspace(value)
    if (!workspace) throw new RepositoryUnavailableError(value.workspaceId)
    return {
      origin: "repository",
      placement: "local",
      projectId: value.projectId,
      documentId: value.documentId,
      workspaceId: value.workspaceId,
      relativePath: normalizeRepositoryRelativePath(value.relativePath),
      canonicalPath: await options.files.resolve(workspace.root, value.relativePath),
    }
  }

  async function resolveWorkspace(entry: ReturnType<typeof repositoryEntry>) {
    const workspace = await options.workspace.resolve(entry.workspaceId)
    if (!workspace) return undefined
    const root = await fs.realpath(workspace.directory).catch((error: unknown) => {
      if (nodeErrorCode(error) === "ENOENT") return undefined
      throw documentErrorFromCause(error, `resolving workspace ${entry.workspaceId}`)
    })
    return root ? { root } : undefined
  }

  async function target(handle: RepositoryDocumentHandle) {
    const workspace = await resolveWorkspace(repositoryEntry(handle))
    if (!workspace) throw new RepositoryUnavailableError(handle.workspaceId)
    return {
      root: workspace.root,
      canonicalPath: await options.files.resolve(workspace.root, handle.relativePath),
    }
  }
}

function repositoryEntry(entry: DocumentEntry | RepositoryDocumentHandle) {
  if (entry.origin !== "repository" || entry.placement !== "local") {
    throw new DocumentInvalidEntryError("Repository documents require repository origin and local placement")
  }
  if (!entry.projectId.trim() || !entry.documentId.trim() || !entry.workspaceId.trim()) {
    throw new DocumentInvalidEntryError("Repository project, document, and workspace ids are required")
  }
  normalizeRepositoryRelativePath(entry.relativePath)
  return entry
}

async function advisoryCapture(create: () => Promise<SnapshotRef>, documentId: string) {
  return await create().catch((error: unknown) => {
    console.error(`[documents] repository snapshot maintenance failed for ${documentId}:`, error)
    return undefined
  })
}
