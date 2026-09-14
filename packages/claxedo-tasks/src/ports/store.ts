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

/**
 * Which predicate a commit found broken, ordered by the answer a caller owes
 * its client: a duplicate receipt means the command already happened and its
 * committed result is the reply, so it outranks the revision, origin and task
 * number conflicts the same commit may also have hit.
 */
export const TASKS_STORE_CONFLICTS = ["duplicate-receipt", "stale-revision", "link-conflict", "number-taken"] as const
export type TasksStoreConflictKind = (typeof TASKS_STORE_CONFLICTS)[number]

/** A predicate an operation reported as holding and the commit found broken. */
export class TasksStoreConflict extends Error {
  constructor(
    readonly kind: TasksStoreConflictKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "TasksStoreConflict"
  }
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
  /**
   * Makes `revision` a predicate of the unit this runs in, writing nothing.
   * False means the stored row is gone or has already moved; true means the
   * unit commits only while it is still at that revision.
   *
   * A caller that acts on a preset it read but never writes has no other way
   * to be arbitrated against a concurrent edit: inside a unit whose predicates
   * are only decided at commit, a second `get` is the same read it already did.
   */
  assertRevision(scopeId: string, presetId: string, revision: number): Promise<boolean>
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
  /**
   * The number the next task created in this project takes: one past the
   * highest any task there has held, archived rows counted, so a number is
   * never handed out twice. Called inside the unit that goes on to insert, so
   * two creates racing one project cannot both read the same highest.
   */
  nextNumber(scopeId: string, projectId: string): Promise<number>
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
   * The link whose session this is. A session id is derived from its origin,
   * so at most one link in a scope names it; undefined when no Start created
   * the session, which is how an ordinary session is told apart from a root
   * a task was started on.
   */
  bySession(scopeId: string, sessionId: string): Promise<TaskSessionLink | undefined>
  /**
   * Every link in the project's tasks that an agent started in the cloud:
   * `startedFrom` set and `placement` cloud, archived tasks included, because
   * the machine a link names is not released by archiving the task.
   */
  listAgentStartedCloud(scopeId: string, projectId: string): Promise<readonly TaskSessionLink[]>
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
   *
   * Units are arbitrated, not interleaved: a unit that rolls back never
   * removes a write another unit committed, and two units that read one row at
   * the same revision cannot both bump it. An operation's `expectedRevision`
   * is the caller's evidence and is never replaced by a value the adapter
   * reads for itself.
   *
   * An adapter with no interactive transaction answers each operation from
   * committed rows and only learns at commit that a predicate it reported as
   * holding has since broken. Such a unit rejects with `TasksStoreConflict`
   * naming the predicate — after operations inside it have already returned
   * success — and every other rejection is `work`'s own.
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

/**
 * Opens one unit at a time, so an adapter whose rollback belongs to the
 * connection rather than to the unit can still promise arbitration: a second
 * `BEGIN` on one connection is an error, and a rollback that restores a
 * snapshot taken before the unit opened would erase a unit that committed
 * meanwhile. A unit that throws still releases the queue.
 */
export function serializedTransactions(
  open: <T>(work: (operations: TasksStoreOperations) => Promise<T>) => Promise<T>,
): TasksStorePort["transaction"] {
  let pending: Promise<unknown> = Promise.resolve()
  return <T>(work: (operations: TasksStoreOperations) => Promise<T>): Promise<T> => {
    const run = () => open(work)
    const settled = pending.then(run, run)
    pending = settled.then(
      () => undefined,
      () => undefined,
    )
    return settled
  }
}
