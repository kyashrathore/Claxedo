import type { DocumentChangedEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { DocumentIndexEntry, DocumentIndexScope } from "./index-store"
import type {
  DocumentActor,
  DocumentEntry,
  DocumentHandle,
  DocumentVersion,
  DocumentWorkspace,
  WriteResult,
} from "./port"

type Awaitable<T> = T | Promise<T>

type MetadataUpdate = Readonly<{
  display_name?: string
  session_id?: string | null
  last_known_file_version?: string | null
}>

export type DocumentWorkspaceAdapter<H extends DocumentHandle> = DocumentWorkspace<H> &
  Readonly<{
    create(
      entry: DocumentEntry,
      request: Readonly<{ markdown: string; actor: DocumentActor; sessionId?: string }>,
    ): Promise<WriteResult>
  }>

export type DocumentsBackend<H extends DocumentHandle = DocumentHandle> = Readonly<{
  index: Readonly<{
    list(
      scope: DocumentIndexScope,
      options?: { archived?: "active" | "archived" | "all" },
    ): Awaitable<DocumentIndexEntry[]>
    /**
     * Optional richer form of `list` that reports whether the project ran past the storage
     * listing bound. Backends that can always enumerate a whole project may omit it.
     */
    listPage?(
      scope: DocumentIndexScope,
      options?: { archived?: "active" | "archived" | "all" },
    ): Awaitable<Readonly<{ entries: DocumentIndexEntry[]; truncated: boolean }>>
    find(orgId: string, documentId: string): Awaitable<DocumentIndexEntry | undefined>
    findRepository(scope: DocumentIndexScope, repositoryId: string): Awaitable<DocumentIndexEntry | undefined>
    create(entry: DocumentIndexEntry): Awaitable<DocumentIndexEntry>
    remove(scope: DocumentIndexScope, documentId: string): Awaitable<void>
    update(scope: DocumentIndexScope, documentId: string, input: MetadataUpdate): Awaitable<DocumentIndexEntry>
    relocate(
      scope: DocumentIndexScope,
      documentId: string,
      input: Readonly<{
        repository_id: string
        repository_relative_path: string
        last_known_file_version: string
        branch?: string | null
      }>,
    ): Awaitable<DocumentIndexEntry>
    archive(scope: DocumentIndexScope, documentId: string): Awaitable<DocumentIndexEntry>
    restore(scope: DocumentIndexScope, documentId: string): Awaitable<DocumentIndexEntry>
    listStatuses(projectId: string): Awaitable<readonly Record<string, unknown>[]>
    transitionStatus(scope: DocumentIndexScope, documentId: string, status: string): Awaitable<DocumentIndexEntry>
    resolveLocalProjectId(directory: string): Awaitable<string>
  }>
  workspace: DocumentWorkspaceAdapter<H>
  managedRelativePath(input: Readonly<{ projectId: string; documentId: string; slug: string }>): string
  placement: "local" | "hosted"
  placementId?: string
  repository?: Readonly<{
    inspect(entry: DocumentEntry): Promise<
      Readonly<{
        identityKey: string
        relativePath: string
        availability:
          | Readonly<{ state: "available"; version: DocumentVersion; sourceHint?: "merge-conflict-markers" }>
          | Readonly<{ state: "missing" | "workspace-unavailable" }>
          | Readonly<{ state: "moved"; relativePath: string }>
      }>
    >
    availability(
      entry: DocumentEntry,
      expectedVersion?: DocumentVersion,
    ): Promise<
      | Readonly<{ state: "available"; version: DocumentVersion; sourceHint?: "merge-conflict-markers" }>
      | Readonly<{ state: "missing" | "workspace-unavailable" }>
      | Readonly<{ state: "moved"; relativePath: string }>
    >
    relocate(
      entry: DocumentEntry,
      relativePath: string,
      expectedVersion: DocumentVersion,
    ): Promise<
      Readonly<{
        identityKey: string
        relativePath: string
        version: DocumentVersion
      }>
    >
    gitSnapshot(entry: DocumentEntry): Promise<
      Readonly<{
        repoRoot: string
        head: string
        branch: string
        blobSha: string
        tracked: boolean
        dirty: boolean
      }>
    >
    commit(
      entry: DocumentEntry,
      request: Readonly<{
        message: string
        expected: Readonly<{ baseCommit?: string; baseBlobSha?: string }>
      }>,
    ): Promise<Readonly<{ commit: string; blobSha: string; version: DocumentVersion }>>
  }>
  agentOpen?(
    entry: DocumentIndexEntry,
    sessionId: string,
    context: Readonly<{ auth?: SignedControlPlaneAuth; origin: string }>,
  ): Promise<Readonly<{ path: string }>>
  runtimeWriteback?(
    entry: DocumentIndexEntry,
    input: Readonly<{
      token: string
      orgId: string
      projectId: string
      workspaceId: string
      sessionId: string
      markdown: string
      expectedVersion: string
    }>,
  ): Promise<WriteResult>
  runtimeEntry?(
    documentId: string,
    input: Readonly<{
      token: string
      orgId: string
      projectId: string
      workspaceId: string
      sessionId: string
    }>,
  ): Promise<DocumentIndexEntry>
  runtimeResolve?(
    entry: DocumentIndexEntry,
    input: Readonly<{
      auth: SignedControlPlaneAuth
      sessionId: string
      choice: "durable" | "draft"
    }>,
  ): Promise<Readonly<{ path: string; preserved?: string; version: string }>>
  runtimeDispose?(
    entry: DocumentIndexEntry,
    input: Readonly<{
      token: string
      orgId: string
      projectId: string
      workspaceId: string
      sessionId: string
    }>,
  ): Promise<void>
  runtimeRenew?(
    entry: DocumentIndexEntry,
    input: Readonly<{
      token: string
      orgId: string
      projectId: string
      workspaceId: string
      sessionId: string
    }>,
  ): Promise<Readonly<{ token: string; expiresAt: number }>>
  remoteList?(
    input: Readonly<{
      auth: SignedControlPlaneAuth
      orgId: string
      projectId: string
      localWorkspaceId: string
      cloudWorkspaceId: string
      sessionId: string
    }>,
  ): Promise<DocumentIndexEntry[]>
  remoteFind?(
    input: Readonly<{
      auth: SignedControlPlaneAuth
      orgId: string
      documentId: string
    }>,
  ): Promise<DocumentIndexEntry | undefined>
  moveToRepository?(
    entry: DocumentIndexEntry,
    destination: Readonly<{ workspaceId: string; relativePath: string }>,
  ): Promise<DocumentIndexEntry>
}>

export class DocumentAgentOpenError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "DocumentAgentOpenError"
  }
}

export type DocumentEventReason =
  | "document.created"
  | "document.metadata_updated"
  | "document.session_changed"
  | "document.status_changed"
  | "document.archived"
  | "document.restored"
  | "document.content_updated"
  | "document.snapshot_restored"
  | "document.repository_indexed"
  | "document.repository_relocated"
  | "document.moved_to_repository"
  | "document.git_committed"

type DocumentEventScope = Readonly<{ orgId: string; projectId: string }>

const eventListeners = new Map<string, Set<(event: Record<string, unknown>) => void>>()
const documentOperationTails = new WeakMap<object, Map<string, Promise<void>>>()

export function subscribeDocumentEvents(
  orgId: string,
  projectId: string,
  listener: (event: Record<string, unknown>) => void,
) {
  const key = eventKey(orgId, projectId)
  const listeners = eventListeners.get(key) ?? new Set()
  listeners.add(listener)
  eventListeners.set(key, listeners)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) eventListeners.delete(key)
  }
}

/**
 * Doorbell sink for the CENTRAL bus.
 *
 * Injected, never imported: this module is in the Worker import graph
 * (`hosted-app.ts` → `routes/documents.ts` → here), and `../bus` pulls
 * `@claxedo/workspace-runtime` — a FORBIDDEN_BARE dependency that
 * `worker.import-graph.test.ts` rejects. Composition roots inject the local
 * bus or hosted `LiveSyncRoom` sink without adding either transport here.
 *
 * The `DocumentChangedEvent` import is type-only, so it is erased and never
 * enters the bundle — while still keeping this envelope in lockstep with the
 * bus union.
 */
export type DocumentChangedSink = (event: DocumentChangedEvent) => unknown | Promise<unknown>

let documentChangedSink: DocumentChangedSink | undefined

export function setDocumentChangedSink(sink: DocumentChangedSink | undefined) {
  documentChangedSink = sink
  return () => {
    if (documentChangedSink === sink) documentChangedSink = undefined
  }
}

export async function publishDocumentEvent(
  scope: DocumentEventScope,
  documentId: string,
  reason: DocumentEventReason,
  version?: DocumentVersion,
  sink = documentChangedSink,
) {
  const ts = Date.now()
  // ⚠ TWO SHAPES, ONE `type` DISCRIMINANT — do not pass one where the other is
  // expected. `event` below is the LEGACY in-process listener payload
  // (`subscribeDocumentEvents`): snake_case and wider (`reason`, `invalidate`).
  // The bus envelope is camelCase and carries identity only. This function is the
  // single boundary where the legacy shape is CONVERTED into the bus shape;
  // nothing else may forward one as the other.
  const event = {
    type: "document.changed",
    document_id: documentId,
    org_id: scope.orgId,
    project_id: scope.projectId,
    reason,
    ...(version ? { version } : {}),
    invalidate: invalidationHints(reason),
    ts,
  }
  for (const listener of eventListeners.get(eventKey(scope.orgId, scope.projectId)) ?? []) listener(event)

  // Fire-and-forget by design: Documents' correctness mechanism is CAS-at-write
  // (`if-match`), not this hint. A dropped nudge costs freshness until the next
  // read/focus; it can never cost a lost or clobbered write. So a failing sink
  // must never fail the mutation that triggered it.
  if (!sink) return
  try {
    await sink({
      type: "document.changed",
      documentId,
      orgId: scope.orgId,
      projectId: scope.projectId,
      ...(version ? { version } : {}),
      ts,
    })
  } catch (error) {
    console.error("[claxedo-server] WARN  document.changed publish failed:", error)
  }
}

export async function withDocumentOperation<T>(owner: object, key: string, run: () => Promise<T>) {
  const operations = documentOperationTails.get(owner) ?? new Map<string, Promise<void>>()
  documentOperationTails.set(owner, operations)
  const previous = operations.get(key) ?? Promise.resolve()
  let release = () => {}
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  operations.set(key, tail)
  await previous
  try {
    return await run()
  } finally {
    release()
    if (operations.get(key) === tail) operations.delete(key)
    if (!operations.size) documentOperationTails.delete(owner)
  }
}

function invalidationHints(reason: DocumentEventReason) {
  if (
    reason === "document.created" ||
    reason === "document.repository_indexed" ||
    reason === "document.snapshot_restored" ||
    reason === "document.repository_relocated" ||
    reason === "document.moved_to_repository" ||
    reason === "document.git_committed" ||
    reason === "document.content_updated"
  ) {
    return ["index", "content", "snapshots"]
  }
  return ["index"]
}

function eventKey(orgId: string, projectId: string) {
  return `${orgId}\0${projectId}`
}
