export type DocumentVersion = string & { readonly __documentVersion: unique symbol }
export type SnapshotID = string & { readonly __snapshotID: unique symbol }

export type DocumentActor = Readonly<{
  type: "user" | "agent" | "system"
  id: string
}>

export type DocumentEntry =
  | Readonly<{
      origin: "managed"
      placement: "local" | "hosted"
      /** Authenticated tenant scope. Required by hosted storage adapters. */
      orgId?: string
      projectId: string
      documentId: string
      relativePath: string
    }>
  | Readonly<{
      origin: "repository"
      placement: "local" | "hosted"
      /** Authenticated tenant scope. Required by hosted storage adapters. */
      orgId?: string
      projectId: string
      documentId: string
      workspaceId: string
      relativePath: string
    }>

export type DocumentHandle = Readonly<{
  origin: DocumentEntry["origin"]
  placement: DocumentEntry["placement"]
  projectId: string
  documentId: string
}>

export type DocumentRead = Readonly<{
  markdown: string
  version: DocumentVersion
  modifiedAt: number
}>

export type SnapshotRef = Readonly<{
  id: SnapshotID
  sha256: string
  size: number
  reason: string
  actor: DocumentActor
  sessionId?: string
  createdAt: number
  pins: readonly string[]
}>

export type WriteResult = DocumentRead & Readonly<{ snapshot?: SnapshotRef }>

export type WriteRequest = Readonly<{
  markdown: string
  expectedVersion: DocumentVersion
  actor: DocumentActor
  sessionId?: string
}>

export type SnapshotRequest = Readonly<{
  reason: string
  actor: DocumentActor
  sessionId?: string
}>

export type RestoreRequest = Readonly<{
  expectedVersion: DocumentVersion | null
  actor: DocumentActor
  sessionId?: string
}>

/**
 * Backend-neutral content authority. Index lifecycle, file watching, and
 * managed-to-repository transitions compose around this core in later units.
 */
export interface DocumentWorkspace<H extends DocumentHandle = DocumentHandle> {
  resolve(entry: DocumentEntry): Promise<H>
  read(handle: H): Promise<DocumentRead>
  write(handle: H, request: WriteRequest): Promise<WriteResult>
  snapshot(handle: H, request: SnapshotRequest): Promise<SnapshotRef>
  listSnapshots(handle: H): Promise<SnapshotRef[]>
  readSnapshot(handle: H, snapshotId: SnapshotID): Promise<DocumentRead>
  restore(handle: H, snapshotId: SnapshotID, request: RestoreRequest): Promise<WriteResult>
  pinSnapshot(handle: H, snapshotId: SnapshotID, pin: string): Promise<SnapshotRef>
  unpinSnapshot(handle: H, snapshotId: SnapshotID, pin: string): Promise<SnapshotRef>
  collectSnapshots(handle: H): Promise<void>
}
