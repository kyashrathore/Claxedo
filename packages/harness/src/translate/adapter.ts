import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime/contracts"
import type { Clock, CreateId } from "@claxedo/agent-event-runtime/contracts"
import type { RawHarnessEvent } from "@claxedo/agent-event-runtime/contracts"
import type { RuntimeDiagnostic } from "@claxedo/agent-event-runtime/contracts"

export type HarnessEventAdapterContext = {
  harness: string
  threadId: string
  now: Clock
  createId: CreateId
}

export type HarnessEventAdapterResult<State = unknown> = {
  state?: State
  events?: AgentRuntimeEvent[]
  diagnostics?: RuntimeDiagnostic[]
}

export type HarnessEventAdapter<State = unknown> = {
  name: string
  createInitialState?: () => State
  /**
   * Adapters may return a full result when they update adapter state or emit
   * diagnostics. They may return a bare event array for stateless happy paths.
   * The runtime normalizes both conventions and stamps harness/thread/raw data.
   */
  translate: (input: {
    state: State
    event: RawHarnessEvent
    context: HarnessEventAdapterContext
  }) => HarnessEventAdapterResult<State> | AgentRuntimeEvent[]
}
