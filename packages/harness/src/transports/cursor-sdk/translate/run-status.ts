import type { LocalRunStreamEvent, SDKMessage } from "@cursor/sdk"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import type { HarnessEventAdapterContext } from "../../../translate/adapter"
import { assertNever } from "./frames"

export function statusEvents(message: Extract<SDKMessage, { type: "status" }>, context: HarnessEventAdapterContext) {
  const status = message.status
  switch (status) {
    case "CREATING":
    case "RUNNING":
      return [{ type: "session-status", status: "busy" }] satisfies AgentRuntimeEvent[]
    case "FINISHED":
      return [
        { type: "session-status", status: "idle" },
        { type: "finish", sessionId: message.run_id || context.threadId },
      ] satisfies AgentRuntimeEvent[]
    case "CANCELLED":
      return [{ type: "session-status", status: "idle" }] satisfies AgentRuntimeEvent[]
    case "ERROR":
    case "EXPIRED":
      return [
        { type: "session-status", status: "error" },
        { type: "error", error: message.message ?? `Cursor run ${status.toLowerCase()}` },
      ] satisfies AgentRuntimeEvent[]
    default:
      return assertNever(status)
  }
}

export function isTerminalSdkStatus(status: Extract<SDKMessage, { type: "status" }>["status"]) {
  return status === "FINISHED" || status === "CANCELLED" || status === "ERROR" || status === "EXPIRED"
}

export function localRunTerminalEvents(
  row: Exclude<LocalRunStreamEvent, { type: "sdk_message" }>,
): AgentRuntimeEvent[] {
  switch (row.type) {
    case "result": {
      const status = row.status
      switch (status) {
        case "finished":
          return [
            { type: "session-status", status: "idle" },
            { type: "finish", sessionId: row.runId },
          ] satisfies AgentRuntimeEvent[]
        case "cancelled":
          return [
            { type: "session-status", status: "idle" },
            { type: "cancelled", sessionId: row.runId },
          ] satisfies AgentRuntimeEvent[]
        case "error":
          return [
            { type: "session-status", status: "error" },
            { type: "error", error: row.errorCode ?? "Cursor run failed" },
          ] satisfies AgentRuntimeEvent[]
        default:
          return assertNever(status)
      }
    }
    case "done":
      return [
        { type: "session-status", status: "idle" },
        { type: "finish", sessionId: row.runId },
      ] satisfies AgentRuntimeEvent[]
    default:
      return assertNever(row)
  }
}
