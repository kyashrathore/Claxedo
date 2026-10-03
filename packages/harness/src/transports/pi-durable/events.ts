import type { AgentEvent } from "@earendil-works/pi-durable"
import type { RoutedEvent } from "../../contract"
import { routedIngest } from "../../translate/ingest"
import { createAgentEventRuntime } from "../../translate/runtime"
import { piDurableAdapter } from "./translate/adapter"

export type PiEvents = (event: AgentEvent) => RoutedEvent[]

export function piDurableEvents(sessionId: string): PiEvents {
  const runtime = createAgentEventRuntime({ harness: "pi", threadId: sessionId, adapter: piDurableAdapter() })
  return (event) => routedIngest(runtime, { source: "pi.durable", method: event.type, payload: event }, { method: event.type })
}
