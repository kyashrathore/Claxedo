import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import type { StopReason } from "./types"
import { createAcpDiagnostics, diagnoseTranslation, shape } from "./diagnostics"

export function translateStopReason(
  stopReason: StopReason,
  sessionId: string,
  diagnostics = createAcpDiagnostics(),
): AgentRuntimeEvent[] {
  switch (stopReason) {
    case "end_turn":
    case "max_tokens":
    case "max_turn_requests":
      return [
        { type: "session-status", status: "idle" },
        { type: "finish", sessionId },
      ]
    case "cancelled":
      return [
        { type: "session-status", status: "idle" },
        { type: "cancelled", sessionId },
      ]
    case "refusal":
      return [
        { type: "session-status", status: "error" },
        { type: "error", error: "Request refused by agent" },
      ]
    default: {
      const _: never = stopReason
      diagnoseTranslation(diagnostics, "acp.dropped_content", {
        reason: "unknown_stop_reason",
        shape: shape(stopReason),
      })
      return [
        { type: "session-status", status: "idle" },
        { type: "finish", sessionId },
      ]
    }
  }
}
