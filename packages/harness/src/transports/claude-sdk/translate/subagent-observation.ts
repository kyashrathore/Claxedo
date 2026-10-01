import type { SubagentObservation } from "@claxedo/agent-runtime-contract"
import type { ClaudeTaskLedger } from "./task-ledger"

export type ClaudeSubagentObservation = SubagentObservation

export function taskCall(toolCallId: string | undefined, ledger: ClaudeTaskLedger): Pick<ClaudeSubagentObservation, "toolCallId" | "toolCallRole"> {
  if (!toolCallId) return {}
  return ledger.isSpawnCall(toolCallId) ? { toolCallId, toolCallRole: "spawn" } : { toolCallId }
}
