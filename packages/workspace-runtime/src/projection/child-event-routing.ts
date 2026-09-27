import type { AgentRuntimeEvent, AgentRuntimeEventOf, RuntimeUsageObservation } from "@claxedo/agent-runtime-contract"
import type { PromptInput } from "@claxedo/agent-runtime-contract"
import type { RuntimeAppendSource, TurnEventProjector } from "./turn-projection"

export const CHILD_EVENT_BUFFER_MAX_COUNT = 256
export const CHILD_EVENT_BUFFER_MAX_BYTES = 1024 * 1024
export const CHILD_EVENT_BUFFER_TTL_MS = 30_000

export type ChildProjectionTarget = {
  sessionId: string
  getAgentSessionId: () => string
  assistantMessageId: string
  created: number
  input: Pick<PromptInput, "userMessageId" | "agent" | "model" | "variant">
}

export type RuntimeEventRoute =
  | { kind: "parent" }
  | { kind: "child"; correlationKey?: string }

type BufferedChildEvent = {
  event: AgentRuntimeEvent
  source: RuntimeAppendSource
  sequence: number
  bytes: number
}

type MeteredUsage = AgentRuntimeEventOf<"usage"> & { observation: RuntimeUsageObservation }

type BufferedCorrelation = {
  events: BufferedChildEvent[]
  timer: ReturnType<typeof setTimeout>
}

type ChildEventRoutingDiagnosticCode =
  | "child_event_route_missing_correlation"
  | "child_event_route_unserializable"
  | "child_event_route_buffer_count_exceeded"
  | "child_event_route_buffer_bytes_exceeded"
  | "child_event_route_buffer_expired"
  | "child_event_route_disposed"
  | "child_event_route_binding_conflict"

export function createChildEventRouter(options: {
  parent: TurnEventProjector
  createChildProjector: (target: ChildProjectionTarget) => TurnEventProjector
  onDiagnostic: (event: AgentRuntimeEvent) => void
  maxCount?: number
  maxBytes?: number
  ttlMs?: number
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}) {
  const maxCount = options.maxCount ?? CHILD_EVENT_BUFFER_MAX_COUNT
  const maxBytes = options.maxBytes ?? CHILD_EVENT_BUFFER_MAX_BYTES
  const ttlMs = options.ttlMs ?? CHILD_EVENT_BUFFER_TTL_MS
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout
  const bindings = new Map<string, ChildProjectionTarget>()
  const projectors = new Map<string, { target: ChildProjectionTarget; projector: TurnEventProjector }>()
  const buffers = new Map<string, BufferedCorrelation>()
  const poisoned = new Set<string>()
  // A correlation whose usage reached the parent keeps metering there after it
  // binds: its later cumulative totals include what the parent already holds.
  const usageOnParent = new Set<string>()
  let bufferedCount = 0
  let bufferedBytes = 0
  let sequence = 0
  let disposed = false

  const diagnose = (code: ChildEventRoutingDiagnosticCode, message: string, details?: Record<string, unknown>) => {
    options.onDiagnostic({
      type: "diagnostic",
      diagnostic: {
        code,
        message,
        severity: "warn",
        source: "child-event-routing",
        ...(details ? { details } : {}),
      },
    })
  }

  const removeBuffer = (correlationKey: string) => {
    const buffer = buffers.get(correlationKey)
    if (!buffer) return []
    clearTimer(buffer.timer)
    buffers.delete(correlationKey)
    bufferedCount -= buffer.events.length
    bufferedBytes -= buffer.events.reduce((total, event) => total + event.bytes, 0)
    return buffer.events
  }

  const meterOnParent = (event: MeteredUsage, source: RuntimeAppendSource, correlationKey?: string) => {
    if (correlationKey) usageOnParent.add(correlationKey)
    options.parent.project(parentScoped(event, correlationKey), source)
  }

  const dropBuffer = (
    correlationKey: string,
    code: ChildEventRoutingDiagnosticCode,
    message: string,
    offending?: BufferedChildEvent,
  ) => {
    const events = [...removeBuffer(correlationKey), ...(offending ? [offending] : [])]
    poisoned.add(correlationKey)
    const usage = survivingUsage(events)
    for (const item of usage) meterOnParent(item.event, item.source, correlationKey)
    const dropped = events.filter((item) => !isMeteredUsage(item.event)).length
    diagnose(code, usage.length ? `${message}; metered ${usage.length} usage observation(s) on the parent turn` : message, {
      correlationKey,
      droppedEvents: dropped,
      rolledUpUsage: usage.length,
    })
  }

  const childProjector = (target: ChildProjectionTarget) => {
    const existing = projectors.get(target.sessionId)
    if (existing) {
      if (!sameTarget(existing.target, target)) {
        throw new Error(`conflicting child projection target for Session ${target.sessionId}`)
      }
      return existing.projector
    }
    const projector = options.createChildProjector(target)
    projectors.set(target.sessionId, { target, projector })
    return projector
  }

  const routeChild = (event: AgentRuntimeEvent, source: RuntimeAppendSource, correlationKey?: string) => {
    if (!correlationKey) {
      if (isMeteredUsage(event)) {
        meterOnParent(event, source)
        diagnose(
          "child_event_route_missing_correlation",
          "Metered a child-owned usage observation without a stable correlation key on the parent turn",
          { eventType: event.type, rolledUpUsage: 1 },
        )
        return
      }
      diagnose(
        "child_event_route_missing_correlation",
        "Dropped a child-owned runtime event without a stable correlation key",
        { eventType: event.type },
      )
      return
    }

    if (usageOnParent.has(correlationKey) && isMeteredUsage(event)) {
      meterOnParent(event, source, correlationKey)
      return
    }
    const target = bindings.get(correlationKey)
    if (target) {
      childProjector(target).project(event, source)
      return
    }
    if (poisoned.has(correlationKey)) {
      if (isMeteredUsage(event)) meterOnParent(event, source, correlationKey)
      return
    }

    const bytes = serializedBytes({ event, source })
    if (bytes === undefined) {
      diagnose(
        "child_event_route_unserializable",
        "Dropped a child-owned runtime event that could not be measured safely",
        { correlationKey, eventType: event.type },
      )
      return
    }
    if (bufferedCount + 1 > maxCount) {
      dropBuffer(
        correlationKey,
        "child_event_route_buffer_count_exceeded",
        `Dropped unresolved child events after the ${maxCount}-event routing limit was reached`,
        { event, source, sequence: sequence++, bytes },
      )
      return
    }
    if (bufferedBytes + bytes > maxBytes) {
      dropBuffer(
        correlationKey,
        "child_event_route_buffer_bytes_exceeded",
        `Dropped unresolved child events after the ${maxBytes}-byte routing limit was reached`,
        { event, source, sequence: sequence++, bytes },
      )
      return
    }

    const buffered = buffers.get(correlationKey) ?? {
      events: [],
      timer: setTimer(() => dropBuffer(
        correlationKey,
        "child_event_route_buffer_expired",
        `Dropped unresolved child events after the ${ttlMs}ms routing window expired`,
      ), ttlMs),
    }
    if (!buffers.has(correlationKey)) buffers.set(correlationKey, buffered)
    buffered.events.push({ event, source, sequence: sequence++, bytes })
    bufferedCount++
    bufferedBytes += bytes
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
    associate: (correlationKey: string, target: ChildProjectionTarget) => {
      if (disposed) throw new Error("child event router is disposed")
      if (!correlationKey) throw new Error("child projection correlation key is required")
      const existing = bindings.get(correlationKey)
      if (existing && !sameTarget(existing, target)) {
        diagnose(
          "child_event_route_binding_conflict",
          "Rejected a conflicting child projection correlation binding",
          {
            correlationKey,
            existingSessionId: existing.sessionId,
            rejectedSessionId: target.sessionId,
          },
        )
        return
      }
      if (existing) return
      const existingProjector = projectors.get(target.sessionId)
      if (existingProjector && !sameTarget(existingProjector.target, target)) {
        diagnose(
          "child_event_route_binding_conflict",
          "Rejected a conflicting child projection target",
          { correlationKey, sessionId: target.sessionId },
        )
        return
      }
      bindings.set(correlationKey, target)
      poisoned.delete(correlationKey)
      for (const buffered of removeBuffer(correlationKey).sort((a, b) => a.sequence - b.sequence)) {
        childProjector(target).project(buffered.event, buffered.source)
      }
    },
    terminalizeParent: (message: string, source: RuntimeAppendSource) => options.parent.terminalizeOpenTools(message, source),
    assistantMessageId: () => options.parent.assistantMessageId(),
    created: () => options.parent.created(),
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const correlationKey of buffers.keys()) {
        dropBuffer(
          correlationKey,
          "child_event_route_disposed",
          "Dropped unresolved child events when their harness execution ended",
        )
      }
    },
  }
}

function isMeteredUsage(event: AgentRuntimeEvent): event is MeteredUsage {
  return event.type === "usage" && event.observation !== undefined
}

/**
 * Tokens a child spent are still the turn's when the child's transcript is
 * lost, so its usage lands on the parent's turn in a scope of its own and adds
 * to the parent's usage instead of replacing it. A child with no correlation
 * key is told apart by the provider session it reports from, so two such
 * children's cumulative totals do not replace each other.
 */
function parentScoped(event: MeteredUsage, correlationKey: string | undefined): MeteredUsage {
  if (event.observation.scope) return event
  const stream = correlationKey ?? `uncorrelated:${event.observation.nativeSessionId ?? event.observation.providerObservationId ?? "unknown"}`
  return { ...event, observation: { ...event.observation, scope: `child:${stream}` } }
}

/** Every delta survives, and each scope's latest cumulative, which replaces the ones before it. */
function survivingUsage(events: readonly BufferedChildEvent[]) {
  const metered = events.flatMap((item) => isMeteredUsage(item.event) ? [{ ...item, event: item.event }] : [])
  const latestCumulative = new Map<string | undefined, number>()
  for (const item of metered) {
    if (item.event.observation.kind === "cumulative") latestCumulative.set(item.event.observation.scope, item.sequence)
  }
  return metered
    .filter((item) => item.event.observation.kind === "delta" || latestCumulative.get(item.event.observation.scope) === item.sequence)
    .sort((left, right) => left.sequence - right.sequence)
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

function serializedBytes(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) return undefined
    return new TextEncoder().encode(serialized).byteLength
  } catch {
    return undefined
  }
}
