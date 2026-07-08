import type {
  ExternalReference,
  IntakeActivity,
  IntakeItem,
  IntakeItemStatus,
  LoadoutSlot,
  LoadoutScopeType,
  ReviewBatch,
  ReviewableDecision,
  ScratchpadEntry,
  WorkEdge,
  WorkEvent,
  WorkItem,
} from "./types"

export interface SyncProjection {
  bindingKey: string
  provider: string
  providerMeta: Record<string, unknown>
  lastStatus?: string
  blockedHash?: string
  archiveHash?: string
  lastSyncedAt?: string
}

export interface ExternalEventDedup {
  provider: string
  externalId: string
  externalEventId: string
  receivedAt: string
}

/**
 * Database-agnostic persistence interface for WorkGraph state.
 *
 * To swap the storage backend, implement this interface and pass the new
 * implementation to WorkGraph. The current implementation is SqliteWorkGraphRepo
 * in db.ts.
 *
 * Note: the interface is synchronous. An async backend (e.g. Postgres) would
 * require returning Promise<T> from every method and adding `await` in WorkGraph.
 * That is a contained change — only WorkGraph.ts needs updating, not the
 * business logic inside it.
 */
export interface WorkGraphRepo {
  // Events
  insertEvent(event: WorkEvent): void
  getEvents(sinceSeq?: number): WorkEvent[]
  getMaxSeq(): number

  // Items
  insertItem(item: WorkItem): void
  updateItem(id: string, changes: Omit<Partial<WorkItem>, "updatedAt">): void
  deleteItem(id: string): void
  getItem(id: string): WorkItem | undefined
  getAllItems(): WorkItem[]

  // Edges
  insertEdge(source: string, target: string): void
  deleteEdge(source: string, target: string): void
  getAllEdges(): WorkEdge[]

  // Slices
  linkItemSlice(itemId: string, sliceId: string): void
  clearItemSlices(itemId: string): void
  getItemSlices(itemId: string): string[]
  getSliceItems(sliceId: string): string[]

  // Scratchpads
  insertScratchpad(entry: ScratchpadEntry): void
  updateScratchpad(id: string, changes: Partial<ScratchpadEntry>): void
  getScratchpadsByItem(workItemId: string): ScratchpadEntry[]
  getScratchpadsBySubject(subjectType: string, subjectId: string): ScratchpadEntry[]
  getScratchpadsNeedingReview(): ScratchpadEntry[]
  getAllScratchpads(): ScratchpadEntry[]
  getScratchpad(id: string): ScratchpadEntry | undefined
  getLatestScratchpadByRun(agentRunId: string): ScratchpadEntry | undefined

  // Intake
  insertIntakeItem(item: IntakeItem): void
  updateIntakeItem(id: string, changes: Partial<Omit<IntakeItem, "id" | "createdAt">>): void
  deleteIntakeItem(id: string): void
  getIntakeItem(id: string): IntakeItem | undefined
  listIntakeItems(): IntakeItem[]
  listIntakeItemsByStatus(status: IntakeItemStatus): IntakeItem[]
  appendIntakeActivity(activity: IntakeActivity): void
  listIntakeActivities(intakeItemId: string): IntakeActivity[]

  // External references
  insertExternalReference(reference: ExternalReference): ExternalReference | null
  updateExternalReference(id: string, changes: Partial<Omit<ExternalReference, "id" | "createdAt">>): void
  getExternalReference(id: string): ExternalReference | undefined
  getExternalReferenceByProvider(provider: string, externalId: string): ExternalReference | undefined
  listExternalReferences(intakeItemId: string): ExternalReference[]
  insertExternalEventDedup(input: ExternalEventDedup): boolean

  // Review
  insertReviewableDecision(decision: ReviewableDecision): void
  updateReviewableDecision(id: string, changes: Partial<Omit<ReviewableDecision, "id" | "createdAt">>): void
  getReviewableDecision(id: string): ReviewableDecision | undefined
  listReviewableDecisions(): ReviewableDecision[]
  listReviewableDecisionsBySubject(subjectType: string, subjectId: string): ReviewableDecision[]
  listOpenReviewableDecisions(): ReviewableDecision[]
  insertReviewBatch(batch: ReviewBatch): void
  updateReviewBatch(id: string, changes: Partial<Omit<ReviewBatch, "id" | "createdAt">>): void
  getReviewBatch(id: string): ReviewBatch | undefined
  listReviewBatches(): ReviewBatch[]

  // Loadout
  insertLoadoutSlot(slot: LoadoutSlot): void
  updateLoadoutSlot(id: string, changes: Partial<Omit<LoadoutSlot, "id" | "createdAt">>): void
  deleteLoadoutSlot(id: string): void
  getLoadoutSlot(id: string): LoadoutSlot | undefined
  listLoadoutSlots(): LoadoutSlot[]
  listLoadoutSlotsByScope(scopeType: LoadoutScopeType, scopeId: string | null): LoadoutSlot[]

  // Sync projection
  getSyncProjection(key: string): SyncProjection | undefined
  upsertSyncProjection(input: Omit<SyncProjection, "lastSyncedAt">): void

  // Lifecycle
  close(): void
}
