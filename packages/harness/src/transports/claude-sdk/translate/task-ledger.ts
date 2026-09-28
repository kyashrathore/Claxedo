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
  startSpawnCall(toolUseId: string): void
  isSpawnCall(toolUseId: string): boolean
  startHostSubagentCall(toolUseId: string): void
  isHostSubagentCall(toolUseId: string): boolean
  nestSubagentCall(toolUseId: string, spawnerKey: string): void
  isNestedSubagentCall(toolUseId: string): boolean
  firstLevelSubagent(correlationKey: string): string
}

type ParentCalls = Pick<ClaudeTaskLedger, "startSpawnCall" | "isSpawnCall" | "startHostSubagentCall" | "isHostSubagentCall">

function parentCalls(): ParentCalls {
  const spawnCalls = new Set<string>()
  const hostSubagentCalls = new Set<string>()
  return {
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
  }
}

export function createClaudeTaskLedger(): ClaudeTaskLedger {
  const tasks = new Map<string, ClaudeTaskRecord>()
  const firstLevelByNestedCall = new Map<string, string>()
  let live = new Set<string>()
  const firstLevelSubagent = (correlationKey: string) => firstLevelByNestedCall.get(correlationKey) ?? correlationKey
  return {
    ...parentCalls(),
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
    nestSubagentCall(toolUseId, spawnerKey) {
      firstLevelByNestedCall.set(toolUseId, firstLevelSubagent(spawnerKey))
    },
    isNestedSubagentCall(toolUseId) {
      return firstLevelByNestedCall.has(toolUseId)
    },
    firstLevelSubagent,
  }
}
