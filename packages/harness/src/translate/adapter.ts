import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import type { Clock, CreateId } from "@claxedo/agent-runtime-contract"
import type { RawHarnessEvent } from "@claxedo/agent-runtime-contract"
import type { RuntimeDiagnostic } from "@claxedo/agent-runtime-contract"

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
  translate: (input: {
    state: State
    event: RawHarnessEvent
    context: HarnessEventAdapterContext
  }) => HarnessEventAdapterResult<State> | AgentRuntimeEvent[]
}
