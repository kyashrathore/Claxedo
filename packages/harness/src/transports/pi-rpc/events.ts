import { asRecord } from "@claxedo/helpers/guards"
import { createAgentEventRuntime } from "../../translate/runtime"
import { piRpcAdapter } from "./translate"
import { piContentText } from "./translate/content"
import type { RoutedEvent } from "../../contract"
import type { PiMessage } from "./rpc"
import { piDialog, piUiEvent } from "./ui"
import { routedIngest } from "../../translate/ingest"

export type PiEvents = (message: PiMessage) => RoutedEvent[]

export function piUserText(message: PiMessage): string | undefined {
  const content = asRecord(message.message)
  if (message.type !== "message_start" || content?.role !== "user") return undefined
  return piContentText(content.content)
}

export function piEvents(sessionId: string): PiEvents {
  const runtime = createAgentEventRuntime({ harness: "pi", threadId: sessionId, adapter: piRpcAdapter() })
  return (message) => {
    const ui = piUiEvent(message)
    if (ui) return [ui]
    if (piDialog(message)) return []
    return routedIngest(runtime, { source: "pi.rpc", method: message.type, payload: message }, { method: message.type })
  }
}
