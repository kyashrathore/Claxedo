import type { RawHarnessEvent } from "@claxedo/agent-event-runtime/contracts"
import type { AgentEventRuntime } from "../translate/runtime"

export function replayRuntimeEvents<State>(runtime: AgentEventRuntime<State>, events: RawHarnessEvent[]) {
  return events.flatMap((event) => runtime.ingest(event).events)
}
