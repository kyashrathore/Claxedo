import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
import type { PromptInput } from "../../index"
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

  const dropBuffer = (
    correlationKey: string,
    code: ChildEventRoutingDiagnosticCode,
    message: string,
  ) => {
    const events = removeBuffer(correlationKey)
    poisoned.add(correlationKey)
    diagnose(code, message, {
      correlationKey,
      droppedEvents: events.length,
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
      diagnose(
        "child_event_route_missing_correlation",
        "Dropped a child-owned runtime event without a stable correlation key",
        { eventType: event.type },
      )
      return
    }

    const target = bindings.get(correlationKey)
    if (target) {
      childProjector(target).project(event, source)
      return
    }
    if (poisoned.has(correlationKey)) return

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
      )
      return
    }
    if (bufferedBytes + bytes > maxBytes) {
      dropBuffer(
        correlationKey,
        "child_event_route_buffer_bytes_exceeded",
        `Dropped unresolved child events after the ${maxBytes}-byte routing limit was reached`,
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
    associate(correlationKey: string, target: ChildProjectionTarget) {
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
    terminalizeParent(message: string, source: RuntimeAppendSource) {
      return options.parent.terminalizeOpenTools(message, source)
    },
    assistantMessageId() {
      return options.parent.assistantMessageId()
    },
    created() {
      return options.parent.created()
    },
    dispose() {
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

export type ChildEventRouter = ReturnType<typeof createChildEventRouter>

function sameTarget(left: ChildProjectionTarget, right: ChildProjectionTarget) {
  return left.sessionId === right.sessionId &&
    left.assistantMessageId === right.assistantMessageId &&
    left.created === right.created &&
    left.input.userMessageId === right.input.userMessageId &&
    left.input.agent === right.input.agent &&
    left.input.model.providerID === right.input.model.providerID &&
    left.input.model.modelID === right.input.model.modelID &&
    left.input.variant === right.input.variant
}

function serializedBytes(value: unknown) {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) return
    return new TextEncoder().encode(serialized).byteLength
  } catch {
    return
  }
}
