export type ClaudeTaskRecord = {
  taskId: string
  toolUseId?: string
  harnessExecutionId?: string
  isAgentTask: boolean
  skipTranscript: boolean
  nested?: boolean
}

export type ClaudeTaskLedger = {
  start(record: ClaudeTaskRecord): void
  get(taskId: string | undefined): ClaudeTaskRecord | undefined
  replaceLive(taskIds: readonly string[]): ClaudeTaskRecord[]
  startHostSubagentCall(toolUseId: string): void
  isHostSubagentCall(toolUseId: string): boolean
  nestSubagentCall(toolUseId: string, spawnerKey: string): void
  isNestedSubagentCall(toolUseId: string): boolean
  firstLevelSubagent(correlationKey: string): string
}

export function createClaudeTaskLedger(): ClaudeTaskLedger {
  const tasks = new Map<string, ClaudeTaskRecord>()
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
