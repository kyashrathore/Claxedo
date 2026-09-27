import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import type { EventRoute, RoutedEvent } from "../contract"

type Runtime = { ingest(input: { source: string; method: string; payload: unknown }): { events: readonly AgentRuntimeEvent[] } }

export function routedIngest(runtime: Runtime, input: { source: string; method: string; payload: unknown },
  route: { method: string; target?: EventRoute; mapEvent?: (event: AgentRuntimeEvent) => AgentRuntimeEvent }): RoutedEvent[] {
  return runtime.ingest(input).events.map((event) => ({
    event: route.mapEvent ? route.mapEvent(event) : event,
    ...(route.target ? { route: route.target } : {}),
    source: { dir: "in", method: route.method },
  }))
}
