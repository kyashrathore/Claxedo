import { createAgentEventRuntime } from "../../translate/runtime"
import { piRpcAdapter } from "./translate"
import type { RoutedEvent } from "../../contract"
import type { PiMessage } from "./rpc"
import { piDialog, piUiEvent } from "./ui"
import { routedIngest } from "../../translate/ingest"

export type PiEvents = (message: PiMessage) => RoutedEvent[]

export function piEvents(sessionId: string): PiEvents {
  const runtime = createAgentEventRuntime({ harness: "pi", threadId: sessionId, adapter: piRpcAdapter() })
  return (message) => {
    const ui = piUiEvent(message)
    if (ui) return [ui]
    if (piDialog(message)) return []
    return routedIngest(runtime, { source: "pi.rpc", method: message.type, payload: message }, { method: message.type })
  }
}
