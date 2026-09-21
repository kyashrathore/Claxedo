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
 * The same goes for `create_subagent`: the assistant `tool_use` block is the
 * only frame that names the tool, and the `tool_result` that answers it
 * carries the `tool_use_id` alone. Any tool can print a child binding — a
 * `cat`, a fetch, another MCP server — so a result binds a child only when
 * this ledger saw the call it answers.
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
  startHostSubagentCall(toolUseId: string): void
  isHostSubagentCall(toolUseId: string): boolean
}

export function createClaudeTaskLedger(): ClaudeTaskLedger {
  const tasks = new Map<string, ClaudeTaskRecord>()
  const hostSubagentCalls = new Set<string>()
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
    startHostSubagentCall(toolUseId) {
      hostSubagentCalls.add(toolUseId)
    },
    isHostSubagentCall(toolUseId) {
      return hostSubagentCalls.has(toolUseId)
    },
  }
}
