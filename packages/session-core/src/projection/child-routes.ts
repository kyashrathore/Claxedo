import type { AgentRuntimeEvent, AgentRuntimeEventOf, RuntimeUsageObservation } from "@claxedo/agent-runtime-contract"
import type { ChildRoute } from "@claxedo/harness/broker"

export type { ChildRoute } from "@claxedo/harness/broker"

export type BoundChildRoute = Extract<ChildRoute, { kind: "bound" }>

export type ChildRouteReader = {
  childRouteBinding(parentSessionId: string, correlationKey: string): { childSessionId: string; assistantMessageId: string } | undefined
  turnEvidence(sessionId: string, turnId: string): { finished: boolean }
}

export type MeteredUsage = AgentRuntimeEventOf<"usage"> & { observation: RuntimeUsageObservation }

/**
 * Where a child-routed event goes, read from the store at delivery. The
 * binding is the broker's durable `bindChildCorrelation` row, so every drain
 * path and every turn of the parent reads the same answer. A child whose
 * current turn already finished takes nothing more: a late frame would append
 * to a turn the store has closed.
 */
export function resolveChildRoute(store: ChildRouteReader, parentSessionId: string, correlationKey: string): ChildRoute {
  const binding = store.childRouteBinding(parentSessionId, correlationKey)
  if (!binding) return { kind: "unbound" }
  if (store.turnEvidence(binding.childSessionId, binding.assistantMessageId).finished) return { kind: "finished", ...binding }
  return { kind: "bound", ...binding }
}

export function childRouteDropped(
  correlationKey: string | undefined,
  route: Exclude<ChildRoute, BoundChildRoute> | { kind: "uncorrelated" },
  event: AgentRuntimeEvent,
): AgentRuntimeEventOf<"diagnostic"> {
  const reason = route.kind === "unbound" ? "names no child bound to this parent"
    : route.kind === "finished" ? "names a child whose turn already finished" : "carries no correlation key"
  return {
    type: "diagnostic",
    diagnostic: {
      code: `child_event_route_${route.kind}`,
      message: `Dropped a child-routed ${event.type} event that ${reason}`,
      severity: "warn",
      source: "child-event-routing",
      details: {
        eventType: event.type,
        ...(correlationKey ? { correlationKey } : {}),
        ...(route.kind === "finished" ? { childSessionId: route.childSessionId, assistantMessageId: route.assistantMessageId } : {}),
      },
    },
  }
}

export function isMeteredUsage(event: AgentRuntimeEvent): event is MeteredUsage {
  return event.type === "usage" && event.observation !== undefined
}

/**
 * Tokens a child spent are still the turn's when the child's transcript is
 * lost, so its usage lands on the parent's turn in a scope of its own and adds
 * to the parent's usage instead of replacing it. A child with no correlation
 * key is told apart by the provider session it reports from, so two such
 * children's cumulative totals do not replace each other.
 */
export function parentScopedUsage(event: MeteredUsage, correlationKey: string | undefined): MeteredUsage {
  if (event.observation.scope) return event
  const stream = correlationKey ?? `uncorrelated:${event.observation.nativeSessionId ?? event.observation.providerObservationId ?? "unknown"}`
  return { ...event, observation: { ...event.observation, scope: `child:${stream}` } }
}
