import type { SignedControlPlaneAuth } from "../control-plane/auth"
import type { DocumentIndexEntry, DocumentIndexScope } from "./index-store"
import type {
  DocumentActor,
  DocumentEntry,
  DocumentHandle,
  DocumentVersion,
  DocumentWorkspace,
  WriteResult,
} from "./port"
import type { DocumentExternalChange } from "./watch"

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
  watch?: Readonly<{
    open(
      entry: DocumentIndexEntry,
      onChange: (change: DocumentExternalChange) => void | Promise<void>,
    ): Promise<Readonly<{ close(): void }>>
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
  | "document.external_changed"
  | "document.snapshot_restored"
  | "document.repository_indexed"
  | "document.repository_relocated"
  | "document.moved_to_repository"
  | "document.git_committed"

type DocumentEventScope = Readonly<{ orgId: string; projectId: string }>

const eventListeners = new Map<string, Set<(event: Record<string, unknown>) => void>>()
const documentOperationTails = new Map<string, Promise<void>>()

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

export function publishDocumentEvent(
  scope: DocumentEventScope,
  documentId: string,
  reason: DocumentEventReason,
  version?: DocumentVersion,
) {
  const event = {
    type: "document.changed",
    document_id: documentId,
    org_id: scope.orgId,
    project_id: scope.projectId,
    reason,
    ...(version ? { version } : {}),
    invalidate: invalidationHints(reason),
    ts: Date.now(),
  }
  for (const listener of eventListeners.get(eventKey(scope.orgId, scope.projectId)) ?? []) listener(event)
}

export async function withDocumentOperation<T>(documentId: string, run: () => Promise<T>) {
  const previous = documentOperationTails.get(documentId) ?? Promise.resolve()
  let release = () => {}
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  documentOperationTails.set(documentId, tail)
  await previous
  try {
    return await run()
  } finally {
    release()
    if (documentOperationTails.get(documentId) === tail) documentOperationTails.delete(documentId)
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
    reason === "document.content_updated" ||
    reason === "document.external_changed"
  ) {
    return ["index", "content", "snapshots"]
  }
  return ["index"]
}

function eventKey(orgId: string, projectId: string) {
  return `${orgId}\0${projectId}`
}
