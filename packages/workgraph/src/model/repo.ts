import type { WorkItem, WorkEdge, WorkEvent, ScratchpadEntry } from "./types"

export interface SyncProjection {
  bindingKey: string
  provider: string
  providerMeta: Record<string, unknown>
  lastStatus?: string
  blockedHash?: string
  archiveHash?: string
  lastSyncedAt?: string
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
  getScratchpadsNeedingReview(): ScratchpadEntry[]
  getAllScratchpads(): ScratchpadEntry[]
  getScratchpad(id: string): ScratchpadEntry | undefined

  // Sync projection
  getSyncProjection(key: string): SyncProjection | undefined
  upsertSyncProjection(input: Omit<SyncProjection, "lastSyncedAt">): void

  // Lifecycle
  close(): void
}
