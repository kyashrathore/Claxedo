export type ClaudeTaskRecord = {
  taskId: string
  toolUseId?: string
  harnessExecutionId?: string
  isAgentTask: boolean
  skipTranscript: boolean
}

/**
 * What a turn has been told about its tasks. `SDKTaskStartedMessage` is the only
 * frame that says what a task is — `subagent_type` names a Task-tool subagent
 * and `skip_transcript` an ambient chore; `SDKTaskNotificationMessage`,
 * `SDKTaskProgressMessage`, `SDKTaskUpdatedMessage` and
 * `SDKBackgroundTasksChangedMessage` carry the id alone, so a reader without
 * this record cannot tell a finished subagent from a finished shell command.
 *
 * One ledger per query. `SDKBackgroundTasksChangedMessage` is a per-process
 * level that emits nothing at startup, so a set kept across processes would
 * report departures for tasks the new process never claimed were live.
 */
export type ClaudeTaskLedger = {
  start(record: ClaudeTaskRecord): void
  get(taskId: string | undefined): ClaudeTaskRecord | undefined
  /**
   * REPLACE semantics, as `SDKBackgroundTasksChangedMessage` states: the payload
   * is every live task, not a delta. Returns the known tasks the payload
   * dropped; an id that left without ever being introduced belongs to no row.
   */
  replaceLive(taskIds: readonly string[]): ClaudeTaskRecord[]
}

export function createClaudeTaskLedger(): ClaudeTaskLedger {
  const tasks = new Map<string, ClaudeTaskRecord>()
  let live = new Set<string>()
  return {
    start(record) {
      tasks.set(record.taskId, record)
    },
    get(taskId) {
      return taskId ? tasks.get(taskId) : undefined
    },
    replaceLive(taskIds) {
      const next = new Set(taskIds)
      const departed = [...live].flatMap((taskId) => next.has(taskId) ? [] : tasks.get(taskId) ?? [])
      live = next
      return departed
    },
  }
}
