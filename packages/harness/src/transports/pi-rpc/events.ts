import { createAgentEventRuntime } from "@claxedo/agent-event-runtime"
import { piRpcAdapter } from "@claxedo/agent-event-runtime/harnesses/pi"
import type { RoutedEvent } from "../../contract"
import type { PiMessage } from "./rpc"
import { piUiEvent } from "./ui"

export function piEvents(sessionId: string) {
  const runtime = createAgentEventRuntime({ harness: "pi", threadId: sessionId, adapter: piRpcAdapter() })
  return (message: PiMessage): RoutedEvent[] => {
    if (message.type === "extension_ui_request") {
      const ui = piUiEvent(message)
      return ui ? [ui] : []
    }
    const result = runtime.ingest({ source: "pi.rpc", method: message.type, payload: message })
    return result.events.map((event) => ({ event, source: { dir: "in" as const, method: message.type } }))
  }
}
