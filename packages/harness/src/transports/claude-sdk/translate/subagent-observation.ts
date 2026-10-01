import type { SubagentMode, SubagentStatus, SubagentToolCallRole } from "@claxedo/agent-runtime-contract"
import type { ClaudeTaskLedger } from "./task-ledger"

export type ClaudeSubagentObservation = {
  observationId: string
  harnessExecutionId?: string
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
  subagentKey?: string
  childSessionId?: string
  transcript?: { kind: "messages" | "live" }
}

export function taskCall(toolCallId: string | undefined, ledger: ClaudeTaskLedger): Pick<ClaudeSubagentObservation, "toolCallId" | "toolCallRole"> {
  if (!toolCallId) return {}
  return ledger.isSpawnCall(toolCallId) ? { toolCallId, toolCallRole: "spawn" } : { toolCallId }
}
