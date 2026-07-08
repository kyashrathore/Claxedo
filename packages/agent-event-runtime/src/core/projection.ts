import type { AgentRuntimeEvent } from "../contracts/agent-runtime-event"
import type { ProjectionSnapshot } from "./state"

export type RuntimeProjection<Event = unknown, State = unknown> = {
  name: string
  ingest: (event: AgentRuntimeEvent) => Event[]
  snapshot: () => ProjectionSnapshot<State>
}
