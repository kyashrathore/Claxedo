export const RUNTIME_GOAL_STATUSES = ["active", "paused", "blocked", "limited", "complete"] as const
export type RuntimeGoalStatus = typeof RUNTIME_GOAL_STATUSES[number]
export type RuntimeGoalSnapshot = {
  /** Claxedo session identity. One session owns at most one Goal. */
  sessionId: string
  objective: string
  status: RuntimeGoalStatus
  createdAt: number
  updatedAt: number
  /** Provider-reported fields. Absence means unknown and must remain absent. */
  tokenBudget?: number
  tokensUsed?: number
  timeUsedSeconds?: number
  iteration?: number
  lastReason?: string
}

export function isRuntimeGoalStatus(value: unknown): value is RuntimeGoalStatus {
  return typeof value === "string" && (RUNTIME_GOAL_STATUSES as readonly string[]).includes(value)
}

export type SubagentStatus = "pending" | "running" | "paused" | "interrupted" | "completed" | "failed" | "killed"

export function isTerminalSubagentStatus(status: string | undefined): boolean {
  return status === "completed" || status === "failed" || status === "killed" || status === "interrupted"
}
export type SubagentMode = "foreground" | "background"
export type SubagentToolCallRole = "spawn" | "interaction"
/**
 * The completion wake a host-owned child owes its parent: `pending` until the
 * runtime has started the parent turn that carries the child's summary.
 */
export type SubagentWake = "pending" | "delivered"
export type SubagentTranscript = {
  kind: "live" | "file" | "messages" | "none"
  ref?: string
}

/** One revision of a subagent row, as the runtime observed it. */
export type AgentSubagentUpdate = {
  subagentKey: string
  revision: number
  toolCallId?: string
  toolCallRole?: SubagentToolCallRole
  mode?: SubagentMode
  status?: SubagentStatus
  /** Revision at which the admission store verified the current run identity. */
  runRevision?: number
  label?: string
  subagentType?: string
  description?: string
  providerId?: string
  providerKind?: string
  childSessionId?: string
  transcript?: SubagentTranscript
  /** Permission and question requests the child is holding open, to be answered by a human. */
  attention?: number
  wake?: SubagentWake
}

export type SubagentObservation = {
  observationId: string
  harnessExecutionId?: string
  subagentKey?: string
  stableCorrelationId?: string
  toolCallId?: string
  toolCallRole?: SubagentToolCallRole
  mode?: SubagentMode
  status?: SubagentStatus
  label?: string
  subagentType?: string
  description?: string
  providerId?: string
  providerKind?: string
  childSessionId?: string
  transcript?: SubagentTranscript
  attention?: number
  wake?: SubagentWake
  wakeResult?: { status: SubagentStatus; text: string; assistantMessageId?: string }
  wakeReceipt?: string
}

export class UnknownHostSubagentKeyError extends Error {
  constructor(
    readonly parentSessionId: string,
    readonly observationId: string,
    readonly subagentKey: string | undefined,
  ) {
    super(`subagent observation ${observationId} names claxedo row ${subagentKey ?? "<none>"}, which ${parentSessionId} never created`)
    this.name = "UnknownHostSubagentKeyError"
  }
}
