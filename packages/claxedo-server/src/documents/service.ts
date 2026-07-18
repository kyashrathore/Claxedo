import type { SignedControlPlaneAuth } from "../control-plane/auth"
import {
  DocumentAgentOpenError,
  publishDocumentEvent,
  withDocumentOperation,
  type DocumentChangedSink,
  type DocumentsBackend,
} from "./backend"
import type { DocumentIndexEntry, DocumentIndexScope } from "./index-store"
import { DocumentVersionConflictError } from "./errors"
import type { DocumentActor, DocumentEntry, DocumentHandle, DocumentVersion, SnapshotID } from "./port"

export type DocumentsServiceScope = DocumentIndexScope & Readonly<{ actor: DocumentActor }>
type Awaitable<T> = T | Promise<T>

export class DocumentsServiceError extends Error {
  constructor(
    readonly code:
      | "document_not_found"
      | "document_repository_unavailable"
      | "document_not_sourced"
      | "document_recovery_required"
      | "document_already_indexed"
      | "document_move_unavailable"
      | "document_placement_unreachable"
      | "document_capability_denied"
      | "document_conflict_resolution_denied"
      | "document_snapshot_corrupt",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "DocumentsServiceError"
  }
}

export function createDocumentsService<H extends DocumentHandle>(
  backend: DocumentsBackend<H>,
  options: { documentChangedSink?: DocumentChangedSink } = {},
) {
  const publish = (
    scope: Parameters<typeof publishDocumentEvent>[0],
    documentId: string,
    reason: Parameters<typeof publishDocumentEvent>[2],
    version?: DocumentVersion,
  ) => publishDocumentEvent(scope, documentId, reason, version, options.documentChangedSink)
  const findEntry = async (orgId: string, documentId: string) => await backend.index.find(orgId, documentId)

  const requireEntry = async (scope: DocumentIndexScope, documentId: string, includeArchived = false) => {
    const entry = await findEntry(scope.orgId, documentId)
    if (!entry || entry.project_id !== scope.projectId || (!includeArchived && entry.archived_at)) throw notFound()
    return entry
  }

  const repositoryFor = (entry?: DocumentIndexEntry) => {
    if (entry && entry.origin_kind !== "repository") {
      throw new DocumentsServiceError("document_not_sourced", "Document is not linked to a repository file")
    }
    if (!backend.repository) {
      throw new DocumentsServiceError("document_repository_unavailable", "Repository documents are unavailable")
    }
    return backend.repository
  }

  const mutateIndex = (
    scope: DocumentsServiceScope,
    documentId: string,
    reason: Parameters<typeof publishDocumentEvent>[2],
    mutate: (entry: DocumentIndexEntry) => Awaitable<DocumentIndexEntry>,
    includeArchived = false,
  ) =>
    withDocumentOperation(backend, documentId, async () => {
      const entry = await requireEntry(scope, documentId, includeArchived)
      const updated = await mutate(entry)
      await publish(scope, documentId, reason)
      return updated
    })

  const runtimeEntry = async (
    documentId: string,
    input: Readonly<{ token: string; orgId: string; projectId: string; workspaceId: string; sessionId: string }>,
  ) => {
    const entry = (await findEntry(input.orgId, documentId)) ?? (await backend.runtimeEntry?.(documentId, input))
    if (!entry || entry.project_id !== input.projectId) throw notFound()
    return entry
  }

  const runtimeConflictEntry = async (orgId: string, documentId: string, auth: SignedControlPlaneAuth) => {
    const entry = (await findEntry(orgId, documentId)) ?? (await backend.remoteFind?.({ auth, orgId, documentId }))
    if (!entry || entry.archived_at) throw notFound()
    return entry
  }

  return {
    listStatuses(projectId: string) {
      return backend.index.listStatuses(projectId)
    },

    list(scope: DocumentIndexScope, archived: "active" | "archived" | "all") {
      return backend.index.list(scope, { archived })
    },

    findEntry,

    async remoteList(
      input: Readonly<{
        auth: SignedControlPlaneAuth
        orgId: string
        projectId: string
        localWorkspaceId: string
        cloudWorkspaceId: string
        sessionId: string
      }>,
    ) {
      if (!backend.remoteList) throw notFound()
      return await backend.remoteList(input)
    },

    async create(
      scope: DocumentsServiceScope,
      input: Readonly<{
        displayName: string
        markdown: string
        status: string
        sessionId: string | null
      }>,
    ) {
      const documentId = `document_${crypto.randomUUID().replaceAll("-", "")}`
      const now = new Date().toISOString()
      const entry = {
        id: documentId,
        org_id: scope.orgId,
        project_id: scope.projectId,
        display_name: input.displayName,
        origin_kind: "managed" as const,
        placement_kind: backend.placement,
        placement_id: backend.placementId ?? "local",
        managed_relative_path: backend.managedRelativePath({
          projectId: scope.projectId,
          documentId,
          slug: input.displayName,
        }),
        repository_id: null,
        workspace_id: null,
        repository_relative_path: null,
        branch: null,
        status: input.status,
        session_id: input.sessionId,
        archived_at: null,
        created_at: now,
        updated_at: now,
        last_opened_at: null,
        last_known_file_version: null,
      } satisfies DocumentIndexEntry
      await backend.index.create(entry)
      const created = await backend.workspace
        .create(portEntry(entry), {
          markdown: input.markdown,
          actor: scope.actor,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        })
        .catch(async (error: unknown) => {
          await backend.index.remove(scope, documentId)
          throw error
        })
      const indexed = await backend.index.update(scope, documentId, { last_known_file_version: created.version })
      await publish(scope, documentId, "document.created", created.version)
      return indexed
    },

    async createFromRepository(
      scope: DocumentsServiceScope,
      input: Readonly<{
        workspaceId: string
        path: string
        displayName?: string
        status: string
        sessionId: string | null
      }>,
    ) {
      const repository = repositoryFor()
      const documentId = `document_${crypto.randomUUID().replaceAll("-", "")}`
      const inspected = await repository.inspect({
        origin: "repository",
        placement: backend.placement,
        projectId: scope.projectId,
        documentId,
        workspaceId: input.workspaceId,
        relativePath: input.path,
      })
      if (inspected.availability.state !== "available") {
        throw new DocumentsServiceError(
          "document_recovery_required",
          "Repository document is not currently available",
          { state: inspected.availability.state },
        )
      }
      const version = inspected.availability.version
      return await withDocumentOperation(backend, `repository:${scope.orgId}:${inspected.identityKey}`, async () => {
        const existing = await backend.index.findRepository(scope, inspected.identityKey)
        if (existing) return { entry: existing, created: false }
        const now = new Date().toISOString()
        const entry = {
          id: documentId,
          org_id: scope.orgId,
          project_id: scope.projectId,
          display_name: input.displayName ?? inspected.relativePath.split("/").at(-1) ?? "Document",
          origin_kind: "repository" as const,
          placement_kind: backend.placement,
          placement_id: input.workspaceId,
          managed_relative_path: null,
          repository_id: inspected.identityKey,
          workspace_id: input.workspaceId,
          repository_relative_path: inspected.relativePath,
          branch: null,
          status: input.status,
          session_id: input.sessionId,
          archived_at: null,
          created_at: now,
          updated_at: now,
          last_opened_at: null,
          last_known_file_version: version,
        } satisfies DocumentIndexEntry
        await backend.index.create(entry)
        await publish(scope, documentId, "document.repository_indexed", version)
        return { entry, created: true }
      })
    },

    updateMetadata(
      scope: DocumentsServiceScope,
      documentId: string,
      input: Readonly<{ display_name?: string; session_id?: string | null }>,
      expectedVersion?: DocumentVersion,
    ) {
      return mutateIndex(scope, documentId, "document.metadata_updated", async (entry) => {
        if (!expectedVersion) return await backend.index.update(scope, documentId, input)
        const handle = await backend.workspace.resolve(portEntry(entry))
        const current = await backend.workspace.read(handle)
        const written = await backend.workspace.write(handle, {
          markdown: current.markdown,
          expectedVersion,
          actor: scope.actor,
          ...(entry.session_id ? { sessionId: entry.session_id } : {}),
        })
        return await backend.index.update(scope, documentId, {
          ...input,
          last_known_file_version: written.version,
        })
      })
    },

    updateSession(scope: DocumentsServiceScope, documentId: string, session_id: string | null) {
      return mutateIndex(scope, documentId, "document.session_changed", () =>
        backend.index.update(scope, documentId, { session_id }),
      )
    },

    transitionStatus(scope: DocumentsServiceScope, documentId: string, status: string) {
      return mutateIndex(scope, documentId, "document.status_changed", () =>
        backend.index.transitionStatus(scope, documentId, status),
      )
    },

    archive(scope: DocumentsServiceScope, documentId: string) {
      return mutateIndex(scope, documentId, "document.archived", () => backend.index.archive(scope, documentId), true)
    },

    restoreIndex(scope: DocumentsServiceScope, documentId: string) {
      return mutateIndex(scope, documentId, "document.restored", () => backend.index.restore(scope, documentId), true)
    },

    availability(scope: DocumentsServiceScope, documentId: string) {
      return withDocumentOperation(backend, documentId, async () => {
        const entry = await requireEntry(scope, documentId, true)
        const availability = await repositoryFor(entry).availability(
          portEntry(entry),
          entry.last_known_file_version ? (entry.last_known_file_version as DocumentVersion) : undefined,
        )
        if (availability.state === "available" && entry.last_known_file_version !== availability.version) {
          await backend.index.update(scope, documentId, { last_known_file_version: availability.version })
        }
        return availability
      })
    },

    relocate(scope: DocumentsServiceScope, documentId: string, path: string, expectedVersion: DocumentVersion) {
      return withDocumentOperation(backend, documentId, async () => {
        const entry = await requireEntry(scope, documentId, true)
        const relocated = await repositoryFor(entry).relocate(portEntry(entry), path, expectedVersion)
        const existing = await backend.index.findRepository(scope, relocated.identityKey)
        if (existing && existing.id !== documentId) {
          throw new DocumentsServiceError("document_already_indexed", "Repository document is already indexed")
        }
        const updated = await backend.index.relocate(scope, documentId, {
          repository_id: relocated.identityKey,
          repository_relative_path: relocated.relativePath,
          last_known_file_version: relocated.version,
        })
        await publish(scope, documentId, "document.repository_relocated", relocated.version)
        return updated
      })
    },

    moveToRepository(
      scope: DocumentsServiceScope,
      documentId: string,
      destination: Readonly<{ workspaceId: string; relativePath: string }>,
    ) {
      return withDocumentOperation(backend, documentId, async () => {
        const entry = await requireEntry(scope, documentId, true)
        if (!backend.moveToRepository) {
          throw new DocumentsServiceError(
            "document_move_unavailable",
            "Moving this document to a repository is unavailable",
          )
        }
        const moved = await backend.moveToRepository(entry, destination)
        await publish(
          scope,
          documentId,
          "document.moved_to_repository",
          moved.last_known_file_version as DocumentVersion,
        )
        return moved
      })
    },

    async gitSnapshot(scope: DocumentsServiceScope, documentId: string) {
      const entry = await requireEntry(scope, documentId)
      return await repositoryFor(entry).gitSnapshot(portEntry(entry))
    },

    gitCommit(
      scope: DocumentsServiceScope,
      documentId: string,
      input: Readonly<{ message: string; expected: Readonly<{ baseCommit?: string; baseBlobSha?: string }> }>,
    ) {
      return withDocumentOperation(backend, documentId, async () => {
        const entry = await requireEntry(scope, documentId)
        const committed = await repositoryFor(entry).commit(portEntry(entry), input)
        await backend.index.update(scope, documentId, { last_known_file_version: committed.version })
        await publish(scope, documentId, "document.git_committed", committed.version)
        return committed
      })
    },

    async findAgentEntry(orgId: string, documentId: string, auth?: SignedControlPlaneAuth) {
      const entry =
        (await findEntry(orgId, documentId)) ??
        (auth && backend.remoteFind ? await backend.remoteFind({ auth, orgId, documentId }) : undefined)
      if (!entry || entry.archived_at) throw notFound()
      return entry
    },

    async agentOpen(
      entry: DocumentIndexEntry,
      sessionId: string,
      context: Readonly<{ auth?: SignedControlPlaneAuth; origin: string }>,
    ) {
      if (!backend.agentOpen) {
        throw new DocumentsServiceError(
          "document_placement_unreachable",
          "This session placement cannot reach the document's canonical file",
        )
      }
      return await backend.agentOpen(entry, sessionId, context).catch((error) => {
        if (error instanceof DocumentAgentOpenError) throw error
        throw new DocumentsServiceError(
          "document_placement_unreachable",
          "This session runtime cannot hydrate the document",
        )
      })
    },

    async runtimeWriteback(
      documentId: string,
      input: Readonly<{
        token: string
        orgId: string
        projectId: string
        workspaceId: string
        sessionId: string
        markdown: string
        expectedVersion: string
      }>,
    ) {
      const runtimeWriteback = backend.runtimeWriteback
      if (!runtimeWriteback) throw notFound()
      return await withDocumentOperation(backend, documentId, async () => {
        const entry = await runtimeEntry(documentId, input)
        if (entry.archived_at) {
          throw new DocumentsServiceError("document_capability_denied", "Document Session Token was rejected")
        }
        const written = await runtimeWriteback(entry, input).catch((error) => {
          if (error instanceof DocumentVersionConflictError) throw error
          throw new DocumentsServiceError("document_capability_denied", "Document Session Token was rejected")
        })
        await publish(input, entry.id, "document.content_updated", written.version)
        return written
      })
    },

    async runtimeRenew(
      documentId: string,
      input: Readonly<{ token: string; orgId: string; projectId: string; workspaceId: string; sessionId: string }>,
    ) {
      const runtimeRenew = backend.runtimeRenew
      if (!runtimeRenew) throw notFound()
      return await withDocumentOperation(backend, documentId, async () => {
        const entry = await runtimeEntry(documentId, input)
        if (entry.archived_at) {
          throw new DocumentsServiceError("document_capability_denied", "Document Session Token was rejected")
        }
        return await runtimeRenew(entry, input).catch(() => {
          throw new DocumentsServiceError("document_capability_denied", "Document Session Token was rejected")
        })
      })
    },

    async findRuntimeConflictEntry(orgId: string, documentId: string, auth: SignedControlPlaneAuth) {
      return await runtimeConflictEntry(orgId, documentId, auth)
    },

    async runtimeResolve(
      entry: DocumentIndexEntry,
      input: Readonly<{ auth: SignedControlPlaneAuth; sessionId: string; choice: "durable" | "draft" }>,
    ) {
      const runtimeResolve = backend.runtimeResolve
      if (!runtimeResolve) throw notFound()
      return await withDocumentOperation(backend, entry.id, async () => {
        const current = await runtimeConflictEntry(entry.org_id, entry.id, input.auth)
        if (current.project_id !== entry.project_id) throw notFound()
        return await runtimeResolve(current, input).catch(() => {
          throw new DocumentsServiceError(
            "document_conflict_resolution_denied",
            "Document conflict resolution was rejected",
          )
        })
      })
    },

    async runtimeDispose(
      documentId: string,
      input: Readonly<{ token: string; orgId: string; projectId: string; workspaceId: string; sessionId: string }>,
    ) {
      if (!backend.runtimeDispose) throw notFound()
      const entry = await runtimeEntry(documentId, input)
      await backend.runtimeDispose(entry, input).catch(() => {
        throw new DocumentsServiceError("document_capability_denied", "Document Session Token was rejected")
      })
    },

    readContent(scope: DocumentsServiceScope, documentId: string) {
      return withDocumentOperation(backend, documentId, async () => {
        const entry = await requireEntry(scope, documentId)
        const read = await backend.workspace.read(await backend.workspace.resolve(portEntry(entry)))
        if (entry.last_known_file_version !== read.version) {
          await backend.index.update(scope, documentId, { last_known_file_version: read.version })
        }
        return read
      })
    },

    workSource(
      scope: DocumentsServiceScope,
      documentId: string,
      input: Readonly<{ targetStreamId?: string; directory?: string; repositoryUrl?: string }>,
    ) {
      return withDocumentOperation(backend, documentId, async () => {
        const entry = await requireEntry(scope, documentId)
        const handle = await backend.workspace.resolve(portEntry(entry))
        const snapshot = await backend.workspace.snapshot(handle, {
          reason: "workgraph.ingest",
          actor: scope.actor,
          ...(entry.session_id ? { sessionId: entry.session_id } : {}),
        })
        const lease = `lease:${Date.now() + 15 * 60_000}:work-source`
        const leased = await backend.workspace.pinSnapshot(handle, snapshot.id, lease)
        const read = await backend.workspace.readSnapshot(handle, snapshot.id)
        const sha256 = await contentSha256(read.markdown)
        if (sha256 !== snapshot.sha256) {
          throw new DocumentsServiceError("document_snapshot_corrupt", "Document snapshot content hash mismatch")
        }
        await backend.workspace.collectSnapshots(handle)
        return {
          locator: {
            projectId: scope.projectId,
            documentId,
            snapshotId: snapshot.id,
            placement: entry.placement_kind,
            ...(input.targetStreamId ? { targetStreamId: input.targetStreamId } : {}),
            ...(input.directory ? { directory: input.directory } : {}),
            ...(input.repositoryUrl ? { repositoryUrl: input.repositoryUrl } : {}),
          },
          documentTitle: entry.display_name,
          markdown: read.markdown,
          contentHash: sha256,
          authoredAt: leased.createdAt,
          authoredBy: leased.actor,
          intakeLease: lease,
        }
      })
    },

    async pinWorkSource(
      scope: DocumentsServiceScope,
      documentId: string,
      snapshotId: SnapshotID,
      input: Readonly<{ workSourceId: string; revisionId: string }>,
    ) {
      const entry = await requireEntry(scope, documentId)
      const handle = await backend.workspace.resolve(portEntry(entry))
      const pinned = await backend.workspace.pinSnapshot(
        handle,
        snapshotId,
        `workgraph:${input.workSourceId}:${input.revisionId}`,
      )
      return await pinned.pins
        .filter((pin) => pin.startsWith("lease:"))
        .reduce(async (previous, pin) => {
          await previous
          return backend.workspace.unpinSnapshot(handle, snapshotId, pin)
        }, Promise.resolve(pinned))
    },

    writeContent(
      scope: DocumentsServiceScope,
      documentId: string,
      input: Readonly<{ markdown: string; displayName?: string; expectedVersion: DocumentVersion }>,
    ) {
      return withDocumentOperation(backend, documentId, async () => {
        const entry = await requireEntry(scope, documentId)
        const handle = await backend.workspace.resolve(portEntry(entry))
        const before = await backend.workspace.read(handle)
        const written = await backend.workspace.write(handle, {
          markdown: input.markdown,
          expectedVersion: input.expectedVersion,
          actor: scope.actor,
          ...(entry.session_id ? { sessionId: entry.session_id } : {}),
        })
        await indexOrRollbackCanonicalWrite({
          documentId,
          committedMarkdown: written.markdown,
          update: () => backend.index.update(scope, documentId, {
            last_known_file_version: written.version,
            ...(input.displayName ? { display_name: input.displayName } : {}),
          }),
          rollback: () => backend.workspace.write(handle, {
            markdown: before.markdown,
            expectedVersion: written.version,
            actor: scope.actor,
            ...(entry.session_id ? { sessionId: entry.session_id } : {}),
          }),
          read: () => backend.workspace.read(handle),
        })
        await publish(scope, documentId, "document.content_updated", written.version)
        return written
      })
    },

    async listSnapshots(scope: DocumentsServiceScope, documentId: string) {
      const entry = await requireEntry(scope, documentId)
      return await backend.workspace.listSnapshots(await backend.workspace.resolve(portEntry(entry)))
    },

    restoreSnapshot(
      scope: DocumentsServiceScope,
      documentId: string,
      snapshotId: SnapshotID,
      expectedVersion: DocumentVersion,
    ) {
      return withDocumentOperation(backend, documentId, async () => {
        const entry = await requireEntry(scope, documentId)
        const handle = await backend.workspace.resolve(portEntry(entry))
        const before = await backend.workspace.read(handle)
        const restored = await backend.workspace.restore(
          handle,
          snapshotId,
          {
            expectedVersion,
            actor: scope.actor,
            ...(entry.session_id ? { sessionId: entry.session_id } : {}),
          },
        )
        await indexOrRollbackCanonicalWrite({
          documentId,
          committedMarkdown: restored.markdown,
          update: () => backend.index.update(scope, documentId, { last_known_file_version: restored.version }),
          rollback: () => backend.workspace.write(handle, {
            markdown: before.markdown,
            expectedVersion: restored.version,
            actor: scope.actor,
            ...(entry.session_id ? { sessionId: entry.session_id } : {}),
          }),
          read: () => backend.workspace.read(handle),
        })
        await publish(scope, documentId, "document.snapshot_restored", restored.version)
        return restored
      })
    },

    async exportContent(scope: DocumentsServiceScope, documentId: string) {
      const entry = await requireEntry(scope, documentId)
      return await backend.workspace.read(await backend.workspace.resolve(portEntry(entry)))
    },
  }
}

function portEntry(entry: DocumentIndexEntry): DocumentEntry {
  if (entry.origin_kind === "managed") {
    return {
      origin: "managed",
      placement: entry.placement_kind,
      orgId: entry.org_id,
      projectId: entry.project_id,
      documentId: entry.id,
      relativePath: entry.managed_relative_path,
    }
  }
  return {
    origin: "repository",
    placement: entry.placement_kind,
    orgId: entry.org_id,
    projectId: entry.project_id,
    documentId: entry.id,
    workspaceId: entry.workspace_id,
    relativePath: entry.repository_relative_path,
  }
}

async function contentSha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function notFound() {
  return new DocumentsServiceError("document_not_found", "Document not found")
}

async function indexOrRollbackCanonicalWrite(input: Readonly<{
  documentId: string
  committedMarkdown: string
  update: () => Promise<unknown> | unknown
  rollback: () => Promise<unknown>
  read: () => Promise<Readonly<{ markdown: string }>>
}>) {
  try {
    await input.update()
  } catch (indexError) {
    const rolledBack = await input.rollback().then(
      () => true,
      () => false,
    )
    if (rolledBack) throw indexError
    const current = await input.read().catch(() => undefined)
    if (current?.markdown !== input.committedMarkdown) throw indexError
    console.error(
      `[documents] canonical write for ${input.documentId} committed while index reconciliation and rollback failed:`,
      indexError,
    )
  }
}
