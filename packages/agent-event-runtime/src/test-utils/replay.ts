import type { RawHarnessEvent } from "../contracts/raw-harness-event"
import type { AgentEventRuntime } from "../core/runtime"

export function replayRuntimeEvents<State>(runtime: AgentEventRuntime<State>, events: RawHarnessEvent[]) {
  return events.flatMap((event) => runtime.ingest(event).events)
}
