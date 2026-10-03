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

export const SUBAGENT_STATUSES = ["pending", "running", "paused", "interrupted", "completed", "failed", "killed"] as const
export type SubagentStatus = typeof SUBAGENT_STATUSES[number]

export function isTerminalSubagentStatus(status: string | undefined): boolean {
  return status === "completed" || status === "failed" || status === "killed" || status === "interrupted"
}
export const SUBAGENT_MODES = ["foreground", "background"] as const
export type SubagentMode = typeof SUBAGENT_MODES[number]
export const SUBAGENT_TOOL_CALL_ROLES = ["spawn", "interaction"] as const
export type SubagentToolCallRole = typeof SUBAGENT_TOOL_CALL_ROLES[number]
/**
 * The completion wake a host-owned child owes its parent: `pending` until the
 * runtime has started the parent turn that carries the child's summary.
 */
export const SUBAGENT_WAKES = ["pending", "delivered"] as const
export type SubagentWake = typeof SUBAGENT_WAKES[number]
export const SUBAGENT_TRANSCRIPT_KINDS = ["live", "file", "messages", "none"] as const
export type SubagentTranscript = {
  kind: typeof SUBAGENT_TRANSCRIPT_KINDS[number]
  ref?: string
}

function isMember<T extends string>(members: readonly T[], value: unknown): value is T {
  return members.some((member) => member === value)
}

export const isSubagentStatus = (value: unknown): value is SubagentStatus => isMember(SUBAGENT_STATUSES, value)
export const isSubagentMode = (value: unknown): value is SubagentMode => isMember(SUBAGENT_MODES, value)
export const isSubagentToolCallRole = (value: unknown): value is SubagentToolCallRole => isMember(SUBAGENT_TOOL_CALL_ROLES, value)
export const isSubagentWake = (value: unknown): value is SubagentWake => isMember(SUBAGENT_WAKES, value)
export const isSubagentTranscriptKind = (value: unknown): value is SubagentTranscript["kind"] => isMember(SUBAGENT_TRANSCRIPT_KINDS, value)

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
  /** The finished run's outcome, owed to the parent until a `wakeReceipt` names this observation. */
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
