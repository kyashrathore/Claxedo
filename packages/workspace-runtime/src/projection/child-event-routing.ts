import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import type { PromptInput } from "@claxedo/agent-runtime-contract"
import { childRouteDropped, isMeteredUsage, parentScopedUsage, type BoundChildRoute, type ChildRoute, type MeteredUsage } from "./child-routes"
import type { TurnEventProjector } from "./turn-projection"
import type { RuntimeAppendSource } from "./session-event-writer"

export type ChildProjectionTarget = {
  sessionId: string
  getAgentSessionId: () => string
  assistantMessageId: string
  created: number
  input: Pick<PromptInput, "userMessageId" | "agent" | "model" | "variant">
  fencingToken?: number
}

export type RuntimeEventRoute =
  | { kind: "parent" }
  | { kind: "child"; correlationKey?: string }

/**
 * A prompted turn's projection of its harness's routed events. A child-routed
 * event goes where the store's binding sends it at the moment it arrives
 * (`resolve`, the same resolver provider turns drain through), so a child
 * bound in an earlier turn of this parent still receives its frames. One the
 * store cannot route is dropped with one diagnostic on the parent turn, where
 * its usage also stays.
 */
export function createChildEventRouter(options: {
  parent: TurnEventProjector
  resolve: (correlationKey: string) => ChildRoute
  childTarget: (route: BoundChildRoute) => ChildProjectionTarget
  createChildProjector: (target: ChildProjectionTarget) => TurnEventProjector
}) {
  const projectors = new Map<string, { target: ChildProjectionTarget; projector: TurnEventProjector }>()
  // A correlation whose usage reached the parent keeps metering there: its
  // later cumulative totals include what the parent already holds.
  const usageOnParent = new Set<string>()
  let disposed = false

  const meterOnParent = (event: MeteredUsage, source: RuntimeAppendSource, correlationKey?: string) => {
    if (correlationKey) usageOnParent.add(correlationKey)
    options.parent.project(parentScopedUsage(event, correlationKey), source)
  }

  const childProjector = (target: ChildProjectionTarget) => {
    const existing = projectors.get(target.sessionId)
    if (existing && sameChildTurn(existing.target, target)) {
      if (!sameTarget(existing.target, target)) {
        throw new Error(`conflicting child projection target for Session ${target.sessionId}`)
      }
      return existing.projector
    }
    const projector = options.createChildProjector(target)
    projectors.set(target.sessionId, { target, projector })
    return projector
  }

  const boundProjector = (route: BoundChildRoute) => {
    const existing = projectors.get(route.childSessionId)
    if (existing?.target.assistantMessageId === route.assistantMessageId) return existing.projector
    return childProjector(options.childTarget(route))
  }

  const routeChild = (event: AgentRuntimeEvent, source: RuntimeAppendSource, correlationKey?: string) => {
    if (correlationKey && usageOnParent.has(correlationKey) && isMeteredUsage(event)) {
      meterOnParent(event, source, correlationKey)
      return
    }
    const route = correlationKey ? options.resolve(correlationKey) : { kind: "uncorrelated" as const }
    if (route.kind === "bound") {
      boundProjector(route).project(event, source)
      return
    }
    if (isMeteredUsage(event)) meterOnParent(event, source, correlationKey)
    options.parent.project(childRouteDropped(correlationKey, route, event), source)
  }

  return {
    project(
      event: AgentRuntimeEvent,
      source: RuntimeAppendSource,
      route: RuntimeEventRoute = { kind: "parent" },
    ) {
      if (disposed) throw new Error("child event router is disposed")
      if (route.kind === "parent") {
        options.parent.project(event, source)
        return
      }
      routeChild(event, source, route.correlationKey)
    },
    /**
     * The child's own turn lifecycle has no correlation key to arrive under —
     * it is the host's statement about the child, not a harness frame routed
     * to it — so the target names the projector directly.
     */
    projectChild: (target: ChildProjectionTarget, event: AgentRuntimeEvent, source: RuntimeAppendSource) => {
      if (disposed) throw new Error("child event router is disposed")
      childProjector(target).project(event, source)
    },
    terminalizeParent: (message: string, source: RuntimeAppendSource) => options.parent.terminalizeOpenTools(message, source),
    assistantMessageId: () => options.parent.assistantMessageId(),
    created: () => options.parent.created(),
    dispose: () => {
      disposed = true
    },
  }
}

/** A child session's later turn has its own assistant message, and replaces the projector of the one before it. */
function sameChildTurn(left: ChildProjectionTarget, right: ChildProjectionTarget) {
  return left.sessionId === right.sessionId && left.assistantMessageId === right.assistantMessageId
}

function sameTarget(left: ChildProjectionTarget, right: ChildProjectionTarget) {
  return left.sessionId === right.sessionId &&
    left.assistantMessageId === right.assistantMessageId &&
    left.created === right.created &&
    left.input.userMessageId === right.input.userMessageId &&
    left.input.agent === right.input.agent &&
    left.input.model?.providerID === right.input.model?.providerID &&
    left.input.model?.modelID === right.input.model?.modelID &&
    left.input.variant === right.input.variant
}
