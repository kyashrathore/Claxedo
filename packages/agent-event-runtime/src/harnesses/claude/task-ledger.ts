export type ClaudeTaskRecord = {
  taskId: string
  toolUseId?: string
  harnessExecutionId?: string
  isAgentTask: boolean
  skipTranscript: boolean
  /** Started by a subagent: its transcript folds into its first-level ancestor's, and it has no row of its own. */
  nested?: boolean
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
 * A task's frames name a `tool_use_id`, and a `create_subagent` result answers
 * one, but that call is a spawn part of the parent's transcript only when the
 * parent's own assistant message carried it as an Agent or `create_subagent`
 * call. A skill's forked execution runs as a task named by the Skill call, a
 * lane it forks names a call only the fork made, and a subagent's own
 * `create_subagent` call lives in that subagent's transcript; the ledger
 * records the parent's spawning calls so only those become spawn edges.
 *
 * A subagent's frames name the Agent call that spawned it in
 * `parent_tool_use_id`, so a subagent's own subagent names a call the parent
 * never made. The ledger records each such call against the first-level
 * subagent it runs under, which is the only child the parent has a session for.
 *
 * One ledger per query. `SDKBackgroundTasksChangedMessage` is a per-process
 * level that emits nothing at startup, so a set kept across processes would
 * report departures for tasks the new process never claimed were live. A
 * background task never outlives its query: the CLI keeps the query open until
 * its background tasks end, even with stdin closed after the turn's result,
 * and the driver reads the query to its end, so the turn stays running and a
 * later prompt steers into it or waits behind it. Against Claude Code 2.1.283,
 * a background Agent held 8 s past the turn's result sent its text,
 * `task_updated` and `task_notification` in that query, then a second
 * `result`; the next query carried no task frame.
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
  /** Records an Agent or `create_subagent` call from the parent's own assistant message. */
  startSpawnCall(toolUseId: string): void
  isSpawnCall(toolUseId: string): boolean
  startHostSubagentCall(toolUseId: string): void
  isHostSubagentCall(toolUseId: string): boolean
  /** Records an Agent call a subagent made, under the subagent `spawnerKey` names. */
  nestSubagentCall(toolUseId: string, spawnerKey: string): void
  isNestedSubagentCall(toolUseId: string): boolean
  /** The first-level subagent a `parent_tool_use_id` runs under; a first-level key answers itself. */
  firstLevelSubagent(correlationKey: string): string
}

export function createClaudeTaskLedger(): ClaudeTaskLedger {
  const tasks = new Map<string, ClaudeTaskRecord>()
  const spawnCalls = new Set<string>()
  const hostSubagentCalls = new Set<string>()
  const firstLevelByNestedCall = new Map<string, string>()
  let live = new Set<string>()
  const firstLevelSubagent = (correlationKey: string) => firstLevelByNestedCall.get(correlationKey) ?? correlationKey
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
    startSpawnCall(toolUseId) {
      spawnCalls.add(toolUseId)
    },
    isSpawnCall(toolUseId) {
      return spawnCalls.has(toolUseId)
    },
    startHostSubagentCall(toolUseId) {
      hostSubagentCalls.add(toolUseId)
    },
    isHostSubagentCall(toolUseId) {
      return hostSubagentCalls.has(toolUseId)
    },
    nestSubagentCall(toolUseId, spawnerKey) {
      firstLevelByNestedCall.set(toolUseId, firstLevelSubagent(spawnerKey))
    },
    isNestedSubagentCall(toolUseId) {
      return firstLevelByNestedCall.has(toolUseId)
    },
    firstLevelSubagent,
  }
}
