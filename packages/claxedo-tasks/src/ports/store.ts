import type {
  ChildListQuery,
  ConfigurationSlot,
  Page,
  Preset,
  PresetListQuery,
  Task,
  TaskListQuery,
  TaskSessionLink,
  TaskStatus,
  TaskSummary,
  TasksCommandName,
  TasksCommandResult,
} from "../contracts"

/**
 * Replay evidence for one `(scopeId, clientRequestId)`: which command it was,
 * a hash of the request it committed for, and the committed result. No
 * execution state, no lease, no lifecycle — a receipt answers "this already
 * happened, here is what it produced" and nothing else.
 */
export type TasksCommandReceipt = {
  scopeId: string
  clientRequestId: string
  commandName: TasksCommandName
  requestHash: string
  result: TasksCommandResult
  createdAt: number
}

export type PresetStoreOperations = {
  get(scopeId: string, presetId: string): Promise<Preset | undefined>
  list(scopeId: string, ownerId: string, query: PresetListQuery): Promise<Page<Preset>>
  /** A duplicate id is a minting fault, not a caller error: adapters throw. */
  insert(preset: Preset): Promise<void>
  /**
   * Writes only when the stored row is at `expectedRevision`. False means no
   * row matched — a stale revision or a row outside the scope — and the
   * adapter must have written nothing.
   */
  update(preset: Preset, expectedRevision: number): Promise<boolean>
}

export type ChildCountFilter = {
  includeArchived: boolean
  /** Counts only children whose status differs, so "any child not done" is one query. */
  excludeStatus: TaskStatus | null
}

export type TaskStoreOperations = {
  get(scopeId: string, taskId: string): Promise<Task | undefined>
  list(scopeId: string, query: TaskListQuery): Promise<Page<TaskSummary>>
  listChildren(scopeId: string, parentTaskId: string, query: ChildListQuery): Promise<Page<TaskSummary>>
  countChildren(scopeId: string, parentTaskId: string, filter: ChildCountFilter): Promise<number>
  insert(task: Task): Promise<void>
  update(task: Task, expectedRevision: number): Promise<boolean>
}

export type LinkInsertOutcome = { status: "inserted" } | { status: "exists"; link: TaskSessionLink }

export type LinkStoreOperations = {
  /** The slot's current link is its highest attempt; undefined when the slot was never started. */
  getCurrent(scopeId: string, taskId: string, slot: ConfigurationSlot): Promise<TaskSessionLink | undefined>
  /** Every attempt of every slot for the task, newest attempt first within a slot. */
  listByTask(scopeId: string, taskId: string): Promise<readonly TaskSessionLink[]>
  /**
   * Compare-and-set on `(scopeId, taskId, slot, attempt)`. An occupied origin
   * is never overwritten; the stored link comes back so the caller can decide
   * whether two clients converged on one session or collided on two.
   */
  insert(link: TaskSessionLink): Promise<LinkInsertOutcome>
}

export type ReceiptStoreOperations = {
  get(scopeId: string, clientRequestId: string): Promise<TasksCommandReceipt | undefined>
  /**
   * Insert-only. False means the key was already taken and nothing was
   * written, which is how two clients racing the same `clientRequestId`
   * collapse into one committed command instead of two.
   */
  put(receipt: TasksCommandReceipt): Promise<boolean>
}

export type TasksStoreOperations = {
  presets: PresetStoreOperations
  tasks: TaskStoreOperations
  links: LinkStoreOperations
  receipts: ReceiptStoreOperations
}

export type TasksStorePort = TasksStoreOperations & {
  /**
   * Runs `work` against operations that commit together or not at all. A
   * throw from `work` rolls the whole unit back and propagates, which is how
   * a failed revision predicate takes its command receipt down with it.
   */
  transaction<T>(work: (operations: TasksStoreOperations) => Promise<T>): Promise<T>
}

/**
 * A port view of operations that are already inside an open transaction, so a
 * service that wants its own unit joins the caller's one instead of asking an
 * adapter for a nested transaction no adapter here promises.
 */
export function joinedTransaction(operations: TasksStoreOperations): TasksStorePort {
  return { ...operations, transaction: (work) => work(operations) }
}
