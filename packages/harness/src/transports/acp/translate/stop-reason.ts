import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import type { StopReason } from "./types"
export function translateStopReason(stopReason: StopReason, sessionId: string): AgentRuntimeEvent[] {
  if (stopReason === "refusal") {
    return [
      { type: "session-status", status: "error" },
      { type: "error", error: "Request refused by agent" },
    ]
  }
  return [
    { type: "session-status", status: "idle" },
    { type: stopReason === "cancelled" ? "cancelled" : "finish", sessionId },
  ]
}
