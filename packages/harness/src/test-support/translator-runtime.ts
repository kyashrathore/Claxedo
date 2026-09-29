import type { RawHarnessEvent } from "@claxedo/agent-runtime-contract"
import type { HarnessEventAdapter } from "../translate/adapter"
import { createAgentEventRuntime } from "../translate/runtime"

export function translatorRuntime<State>(options: Parameters<typeof createAgentEventRuntime<State>>[0] & { adapter: HarnessEventAdapter<State> }) {
  const runtime = createAgentEventRuntime(options)
  let state = options.adapter.createInitialState?.() as State
  return {
    ingest(event: RawHarnessEvent) {
      const result = runtime.ingest(event)
      state = result.state
      return result
    },
    state: () => state,
  }
}
