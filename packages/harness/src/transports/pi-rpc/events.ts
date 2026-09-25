import { createAgentEventRuntime } from "@claxedo/agent-event-runtime"
import { piRpcAdapter } from "@claxedo/agent-event-runtime/harnesses/pi"
import type { RoutedEvent } from "../../contract"
import type { PiMessage } from "./rpc"
import { piUiEvent } from "./ui"
import { unrecognizedEvent } from "../../translate/unrecognized"
import { routedIngest } from "../../translate/ingest"

function recognized(type: string): boolean {
  switch (type) {
    case "extension_ui_request": case "session_info_changed": case "agent_start": case "message_start":
    case "message_update": case "message_end": case "tool_execution_start": case "tool_execution_end":
    case "auto_compaction_start": case "compaction_start": case "auto_compaction_end": case "compaction_end":
    case "tool_execution_update": case "extension_notify": case "auto_retry_start": case "extension_error":
    case "agent_settled": return true
    default: return false
  }
}

export function piEvents(sessionId: string) {
  const runtime = createAgentEventRuntime({ harness: "pi", threadId: sessionId, adapter: piRpcAdapter() })
  return (message: PiMessage): RoutedEvent[] => {
    if (message.type === "extension_ui_request") {
      const ui = piUiEvent(message)
      if (ui) return [ui]
      if (typeof message.method === "string" && ["select", "confirm", "input", "editor"].includes(message.method)) return []
      return [{ event: unrecognizedEvent("pi.rpc", `extension_ui.${String(message.method)}`, message) }]
    }
    if (!recognized(message.type)) return [{ event: unrecognizedEvent("pi.rpc", message.type, message) }]
    return routedIngest(runtime, { source: "pi.rpc", method: message.type, payload: message }, { method: message.type })
  }
}
