import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { cloneSnapshotValue } from "@claxedo/helpers"

export const PROJECTION_SNAPSHOT_VERSION = 1

export type ProjectionSnapshot<State = unknown> = {
  version: typeof PROJECTION_SNAPSHOT_VERSION
  projection: string
  state: State
}

export type RuntimeProjection<Event = unknown, State = unknown> = {
  name: string
  ingest: (event: AgentRuntimeEvent) => Event[]
  snapshot: () => ProjectionSnapshot<State>
}

export function projectionSnapshot<State>(projection: string, state: State): ProjectionSnapshot<State> {
  return { version: PROJECTION_SNAPSHOT_VERSION, projection, state: cloneSnapshotValue(state) }
}
