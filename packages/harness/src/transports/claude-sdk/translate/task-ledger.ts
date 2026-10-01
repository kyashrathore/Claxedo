export type ClaudeTaskRecord = {
  taskId: string
  toolUseId?: string
  isAgentTask: boolean
  skipTranscript: boolean
  nested?: boolean
}

export type ClaudeTaskLedger = ReturnType<typeof createClaudeTaskLedger>

export function createClaudeTaskLedger() {
  const tasks = new Map<string, ClaudeTaskRecord>()
  const firstLevelByNestedCall = new Map<string, string>()
  const spawnCalls = new Set<string>()
  const hostSubagentCalls = new Set<string>()
  const firstLevelSubagent = (correlationKey: string) => firstLevelByNestedCall.get(correlationKey) ?? correlationKey
  return {
    startSpawnCall(toolUseId: string) {
      spawnCalls.add(toolUseId)
    },
    isSpawnCall(toolUseId: string) {
      return spawnCalls.has(toolUseId)
    },
    startHostSubagentCall(toolUseId: string) {
      hostSubagentCalls.add(toolUseId)
    },
    isHostSubagentCall(toolUseId: string) {
      return hostSubagentCalls.has(toolUseId)
    },
    start(record: ClaudeTaskRecord) {
      tasks.set(record.taskId, record)
    },
    get(taskId: string | undefined) {
      return taskId ? tasks.get(taskId) : undefined
    },
    nestSubagentCall(toolUseId: string, spawnerKey: string) {
      firstLevelByNestedCall.set(toolUseId, firstLevelSubagent(spawnerKey))
    },
    isNestedSubagentCall(toolUseId: string) {
      return firstLevelByNestedCall.has(toolUseId)
    },
    firstLevelSubagent,
  }
}
