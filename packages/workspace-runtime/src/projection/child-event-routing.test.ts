import { describe, expect, test } from "bun:test"
import type { AgentRuntimeEvent, RuntimeUsageObservation } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/helpers/guards"
import type { CompatEvent } from "@claxedo/agent-sdk-runtime/compat-events"
import type { RuntimeEventEnvelopeInput } from "./runtime-event-hub"
import {
  CHILD_EVENT_BUFFER_MAX_BYTES,
  CHILD_EVENT_BUFFER_MAX_COUNT,
  createChildEventRouter,
  type ChildProjectionTarget,
} from "./child-event-routing"
import type { RuntimeAppendSource } from "./turn-projection"
import { testTurnProjector } from "../test-support/turn-projector"

const source: RuntimeAppendSource = { dir: "in", method: "test" }

function target(sessionId = "child-1"): ChildProjectionTarget {
  return {
    sessionId,
    getAgentSessionId: () => `provider-${sessionId}`,
    assistantMessageId: `${sessionId}-assistant-1`,
    created: 100,
    input: {
      userMessageId: `${sessionId}-user-1`,
      agent: "general",
      model: { providerID: "test", modelID: "model" },
      variant: "default",
    },
  }
}

function fixture(input: {
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  maxCount?: number
  maxBytes?: number
} = {}) {
  const journal: Array<{ sessionId: string; agentSessionId?: string; payload: CompatEvent }> = []
  const parentCompat: CompatEvent[] = []
  const childCompat: CompatEvent[] = []
  const runtime: RuntimeEventEnvelopeInput[] = []
  const diagnostics: AgentRuntimeEvent[] = []
  let childProjectors = 0
  const appendEvent = (event: { sessionId: string; agentSessionId?: string; payload: CompatEvent }) => {
    journal.push(event)
    return { payload: event.payload }
  }
  const parent = testTurnProjector({
    appendEvent,
    owner: { sessionId: "parent-1", getAgentSessionId: () => "provider-parent-1" },
    input: target("parent-1").input,
    assistantMessageId: "parent-assistant-1",
    onEvent: (event) => parentCompat.push(event),
    onRuntimeEvent: (event) => runtime.push(event),
  })
  const router = createChildEventRouter({
    parent,
    createChildProjector: (child) => {
      childProjectors++
      return testTurnProjector({
        appendEvent,
        owner: { sessionId: child.sessionId, getAgentSessionId: child.getAgentSessionId },
        input: child.input,
        assistantMessageId: child.assistantMessageId,
        created: child.created,
        onEvent: (event) => childCompat.push(event),
        onRuntimeEvent: (event) => runtime.push(event),
      })
    },
    onDiagnostic: (event) => diagnostics.push(event),
    setTimer: input.setTimer,
    clearTimer: input.clearTimer,
    maxCount: input.maxCount,
    maxBytes: input.maxBytes,
  })
  return {
    router,
    journal,
    parentCompat,
    childCompat,
    runtime,
    diagnostics,
    childProjectors: () => childProjectors,
  }
}

function diagnosticCodes(events: AgentRuntimeEvent[]) {
  return events.flatMap((event) => event.type === "diagnostic" ? [event.diagnostic.code] : [])
}

function usage(input: number, observation: Partial<RuntimeUsageObservation> = {}): AgentRuntimeEvent {
  return {
    type: "usage",
    contextSize: 1000,
    contextUsed: input,
    observation: {
      kind: "cumulative",
      tokens: { input, output: 1, reasoning: null, cache: { read: null, write: null } },
      ...observation,
    },
  }
}

function meteredOn(events: CompatEvent[]) {
  return events.flatMap((event) => event.type === "session.usage" && event.properties.observation
    ? [{
        sessionID: event.properties.sessionID,
        kind: event.properties.observation.kind,
        scope: asRecord(event.properties.observation)?.scope,
        input: event.properties.observation.tokens.input,
      }]
    : [])
}

function diagnosticDetails(events: AgentRuntimeEvent[]) {
  return events.flatMap((event) => event.type === "diagnostic" ? [event.diagnostic.details] : [])
}

describe("createChildEventRouter", () => {
  test("persists and publishes child-owned events only under the child owner", () => {
    const item = fixture()

    item.router.associate("thread-1", target())
    item.router.project(
      { type: "text-delta", delta: "child text" },
      source,
      { kind: "child", correlationKey: "thread-1" },
    )

    expect(item.journal.length).toBeGreaterThan(0)
    expect(item.journal.every((event) =>
      event.sessionId === "child-1" && event.agentSessionId === "provider-child-1"
    )).toBe(true)
    expect(item.parentCompat).toEqual([])
    expect(item.childCompat.length).toBeGreaterThan(0)
    expect(item.runtime.every((event) =>
      event.sessionId === "child-1" && event.agentSessionId === "provider-child-1"
    )).toBe(true)
    item.router.dispose()
  })

  test("flushes content received across a live reconnect in source order after association", () => {
    const item = fixture()

    item.router.project(
      { type: "text-delta", delta: "before reconnect" },
      { ...source, method: "connection-1" },
      { kind: "child", correlationKey: "thread-1" },
    )
    item.router.project(
      { type: "text-delta", delta: "after reconnect" },
      { ...source, method: "connection-2" },
      { kind: "child", correlationKey: "thread-1" },
    )
    expect(item.journal).toEqual([])

    item.router.associate("thread-1", target())

    expect(item.childCompat.flatMap((event) =>
      event.type === "message.part.delta" ? [event.properties.delta] : []
    )).toEqual(["before reconnect", "after reconnect"])
    expect(item.journal.every((event) => event.sessionId === "child-1")).toBe(true)
    item.router.dispose()
  })

  test("expires the offending correlation at the 257th unresolved event", () => {
    const item = fixture()

    for (let index = 0; index <= CHILD_EVENT_BUFFER_MAX_COUNT; index++) {
      item.router.project(
        { type: "text-delta", delta: String(index) },
        source,
        { kind: "child", correlationKey: "overflow" },
      )
    }
    item.router.associate("overflow", target())

    expect(item.journal).toEqual([])
    expect(diagnosticCodes(item.diagnostics)).toEqual(["child_event_route_buffer_count_exceeded"])
    item.router.dispose()
  })

  test("expires an unresolved correlation that exceeds one MiB", () => {
    const item = fixture()

    item.router.project(
      { type: "text-delta", delta: "x".repeat(CHILD_EVENT_BUFFER_MAX_BYTES) },
      source,
      { kind: "child", correlationKey: "too-large" },
    )
    item.router.associate("too-large", target())

    expect(item.journal).toEqual([])
    expect(diagnosticCodes(item.diagnostics)).toEqual(["child_event_route_buffer_bytes_exceeded"])
    item.router.dispose()
  })

  test("expires unresolved content after thirty seconds without a journal write", () => {
    let expire: (() => void) | undefined
    let delay = 0
    let cleared = 0
    const item = fixture({
      setTimer(callback, timeout) {
        expire = callback
        delay = timeout
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer() {
        cleared++
      },
    })

    item.router.project(
      { type: "text-delta", delta: "waiting" },
      source,
      { kind: "child", correlationKey: "late" },
    )
    expire?.()
    item.router.associate("late", target())

    expect(delay).toBe(30_000)
    expect(cleared).toBe(1)
    expect(item.journal).toEqual([])
    expect(diagnosticCodes(item.diagnostics)).toEqual(["child_event_route_buffer_expired"])
    item.router.dispose()
  })

  test("keeps unrelated buffered correlations when one correlation overflows", () => {
    const item = fixture({ maxCount: 2 })

    item.router.project(
      { type: "text-delta", delta: "survives" },
      source,
      { kind: "child", correlationKey: "healthy" },
    )
    item.router.project(
      { type: "text-delta", delta: "first offender" },
      source,
      { kind: "child", correlationKey: "overflow" },
    )
    item.router.project(
      { type: "text-delta", delta: "overflow" },
      source,
      { kind: "child", correlationKey: "overflow" },
    )
    item.router.associate("healthy", target())

    expect(JSON.stringify(item.journal)).toContain("survives")
    expect(JSON.stringify(item.journal)).not.toContain("first offender")
    expect(diagnosticCodes(item.diagnostics)).toEqual(["child_event_route_buffer_count_exceeded"])
    item.router.dispose()
  })

  test("drops unmeasurable child events without poisoning later serializable content", () => {
    const item = fixture()
    const circular: Record<string, unknown> = {}
    circular.self = circular

    item.router.project(
      {
        type: "tool-start",
        toolCallId: "unmeasurable",
        toolName: "test",
        metadata: circular,
      },
      source,
      { kind: "child", correlationKey: "thread-1" },
    )
    item.router.project(
      { type: "text-delta", delta: "measurable" },
      source,
      { kind: "child", correlationKey: "thread-1" },
    )
    item.router.associate("thread-1", target())

    expect(JSON.stringify(item.journal)).toContain("measurable")
    expect(JSON.stringify(item.journal)).not.toContain("unmeasurable")
    expect(diagnosticCodes(item.diagnostics)).toEqual(["child_event_route_unserializable"])
    item.router.dispose()
  })

  test("drops uncorrelated child events diagnostically without writing either journal", () => {
    const item = fixture()

    item.router.project({ type: "text-delta", delta: "lost" }, source, { kind: "child" })

    expect(item.journal).toEqual([])
    expect(item.parentCompat).toEqual([])
    expect(item.childCompat).toEqual([])
    expect(diagnosticCodes(item.diagnostics)).toEqual(["child_event_route_missing_correlation"])
    item.router.dispose()
  })

  test("keeps the original binding when a conflicting rebind is rejected diagnostically", () => {
    const item = fixture()

    item.router.associate("thread-1", target())
    item.router.associate("thread-1", target())
    item.router.associate("thread-1", target("child-2"))
    item.router.project(
      { type: "text-delta", delta: "owned by first" },
      source,
      { kind: "child", correlationKey: "thread-1" },
    )

    expect(item.journal.length).toBeGreaterThan(0)
    expect(item.journal.every((event) => event.sessionId === "child-1")).toBe(true)
    expect(diagnosticCodes(item.diagnostics)).toEqual(["child_event_route_binding_conflict"])
    item.router.dispose()
  })

  test("aliases multiple correlation keys to one lazily created child projector", () => {
    const item = fixture()

    item.router.associate("spawn", target())
    item.router.associate("interaction", target())
    expect(item.childProjectors()).toBe(0)
    item.router.project(
      { type: "text-delta", delta: "spawn" },
      source,
      { kind: "child", correlationKey: "spawn" },
    )
    item.router.project(
      { type: "text-delta", delta: "interaction" },
      source,
      { kind: "child", correlationKey: "interaction" },
    )

    expect(item.childProjectors()).toBe(1)
    expect(item.journal.every((event) => event.sessionId === "child-1")).toBe(true)
    item.router.dispose()
  })

  test("dispose clears timers and drops unresolved content diagnostically", () => {
    let cleared = 0
    const item = fixture({
      setTimer() {
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer() {
        cleared++
      },
    })

    item.router.project(
      { type: "text-delta", delta: "pending" },
      source,
      { kind: "child", correlationKey: "pending" },
    )
    item.router.dispose()
    item.router.dispose()

    expect(cleared).toBe(1)
    expect(item.journal).toEqual([])
    expect(diagnosticCodes(item.diagnostics)).toEqual(["child_event_route_disposed"])
  })
  describe("usage a dropped child would lose", () => {
    test("reaches the parent turn when its correlation expires, as each scope's latest cumulative and every delta", () => {
      let expire: (() => void) | undefined
      const item = fixture({
        setTimer(callback) {
          expire = callback
          return 1 as unknown as ReturnType<typeof setTimeout>
        },
      })
      const child = { kind: "child" as const, correlationKey: "late" }

      item.router.project({ type: "text-delta", delta: "child text" }, source, child)
      item.router.project(usage(10), source, child)
      item.router.project(usage(3, { kind: "delta", providerObservationId: "step-1" }), source, child)
      item.router.project(usage(25), source, child)
      item.router.project(usage(7, { scope: "thread-late:turn-1" }), source, child)
      expire?.()

      expect(meteredOn(item.parentCompat)).toEqual([
        { sessionID: "parent-1", kind: "delta", scope: "child:late", input: 3 },
        { sessionID: "parent-1", kind: "cumulative", scope: "child:late", input: 25 },
        { sessionID: "parent-1", kind: "cumulative", scope: "thread-late:turn-1", input: 7 },
      ])
      expect(JSON.stringify(item.journal)).not.toContain("child text")
      expect(item.childCompat).toEqual([])
      expect(diagnosticCodes(item.diagnostics)).toEqual(["child_event_route_buffer_expired"])
      expect(diagnosticDetails(item.diagnostics)).toEqual([{ correlationKey: "late", droppedEvents: 1, rolledUpUsage: 3 }])
      item.router.dispose()
    })

    test("reaches the parent turn when the turn ends before its correlation binds", () => {
      const item = fixture()

      item.router.project({ type: "text-delta", delta: "unbound transcript" }, source, { kind: "child", correlationKey: "pending" })
      item.router.project(usage(12, { scope: "thread-pending:turn-1" }), source, { kind: "child", correlationKey: "pending" })
      item.router.dispose()

      expect(meteredOn(item.parentCompat)).toEqual([
        { sessionID: "parent-1", kind: "cumulative", scope: "thread-pending:turn-1", input: 12 },
      ])
      expect(JSON.stringify(item.journal)).not.toContain("unbound transcript")
      expect(diagnosticCodes(item.diagnostics)).toEqual(["child_event_route_disposed"])
      expect(diagnosticDetails(item.diagnostics)).toEqual([{ correlationKey: "pending", droppedEvents: 1, rolledUpUsage: 1 }])
    })

    test("reaches the parent turn when its correlation overflows the count or byte limit, the overflowing event included", () => {
      const counted = fixture({ maxCount: 2 })
      counted.router.project({ type: "text-delta", delta: "a" }, source, { kind: "child", correlationKey: "overflow" })
      counted.router.project(usage(4), source, { kind: "child", correlationKey: "overflow" })
      counted.router.project(usage(9, { kind: "delta", providerObservationId: "step-9" }), source, { kind: "child", correlationKey: "overflow" })

      expect(meteredOn(counted.parentCompat)).toEqual([
        { sessionID: "parent-1", kind: "cumulative", scope: "child:overflow", input: 4 },
        { sessionID: "parent-1", kind: "delta", scope: "child:overflow", input: 9 },
      ])
      expect(diagnosticCodes(counted.diagnostics)).toEqual(["child_event_route_buffer_count_exceeded"])
      expect(diagnosticDetails(counted.diagnostics)).toEqual([{ correlationKey: "overflow", droppedEvents: 1, rolledUpUsage: 2 }])
      counted.router.dispose()

      const sized = fixture({ maxBytes: 64 })
      sized.router.project(usage(6), source, { kind: "child", correlationKey: "too-large" })
      expect(meteredOn(sized.parentCompat)).toEqual([
        { sessionID: "parent-1", kind: "cumulative", scope: "child:too-large", input: 6 },
      ])
      expect(diagnosticCodes(sized.diagnostics)).toEqual(["child_event_route_buffer_bytes_exceeded"])
      sized.router.dispose()
    })

    test("reaches the parent turn after its correlation is poisoned, while the child's transcript stays dropped", () => {
      const item = fixture({ maxCount: 1 })
      item.router.project({ type: "text-delta", delta: "first" }, source, { kind: "child", correlationKey: "poisoned" })
      item.router.project({ type: "text-delta", delta: "overflow" }, source, { kind: "child", correlationKey: "poisoned" })
      item.router.project({ type: "text-delta", delta: "after poison" }, source, { kind: "child", correlationKey: "poisoned" })
      item.router.project(usage(30), source, { kind: "child", correlationKey: "poisoned" })

      expect(meteredOn(item.parentCompat)).toEqual([
        { sessionID: "parent-1", kind: "cumulative", scope: "child:poisoned", input: 30 },
      ])
      expect(JSON.stringify(item.journal)).not.toContain("after poison")
      expect(diagnosticCodes(item.diagnostics)).toEqual(["child_event_route_buffer_count_exceeded"])
      item.router.dispose()
    })

    test("keeps metering on the parent once a rolled-up correlation binds, so its cumulative is counted once", () => {
      let expire: (() => void) | undefined
      const item = fixture({
        setTimer(callback) {
          expire = callback
          return 1 as unknown as ReturnType<typeof setTimeout>
        },
      })
      item.router.project(usage(10), source, { kind: "child", correlationKey: "late" })
      expire?.()
      item.router.associate("late", target())
      item.router.project({ type: "text-delta", delta: "bound text" }, source, { kind: "child", correlationKey: "late" })
      item.router.project(usage(40), source, { kind: "child", correlationKey: "late" })

      expect(meteredOn(item.parentCompat)).toEqual([
        { sessionID: "parent-1", kind: "cumulative", scope: "child:late", input: 10 },
        { sessionID: "parent-1", kind: "cumulative", scope: "child:late", input: 40 },
      ])
      expect(meteredOn(item.childCompat)).toEqual([])
      expect(JSON.stringify(item.childCompat)).toContain("bound text")
      item.router.dispose()
    })

    test("reaches the parent turn without a correlation key, and other uncorrelated events are still dropped", () => {
      const item = fixture()

      item.router.project(usage(5), source, { kind: "child" })
      item.router.project({ type: "text-delta", delta: "lost" }, source, { kind: "child" })

      expect(meteredOn(item.parentCompat)).toEqual([
        { sessionID: "parent-1", kind: "cumulative", scope: "child:uncorrelated:unknown", input: 5 },
      ])
      expect(JSON.stringify(item.journal)).not.toContain("lost")
      expect(diagnosticCodes(item.diagnostics)).toEqual([
        "child_event_route_missing_correlation",
        "child_event_route_missing_correlation",
      ])
      expect(diagnosticDetails(item.diagnostics)).toEqual([{ eventType: "usage", rolledUpUsage: 1 }, { eventType: "text-delta" }])
      item.router.dispose()
    })

    test("keeps two uncorrelated children apart by the provider session each reports from", () => {
      const item = fixture()

      item.router.project(usage(5, { nativeSessionId: "child-a" }), source, { kind: "child" })
      item.router.project(usage(7, { nativeSessionId: "child-b" }), source, { kind: "child" })
      item.router.project(usage(9, { nativeSessionId: "child-a" }), source, { kind: "child" })

      expect(meteredOn(item.parentCompat)).toEqual([
        { sessionID: "parent-1", kind: "cumulative", scope: "child:uncorrelated:child-a", input: 5 },
        { sessionID: "parent-1", kind: "cumulative", scope: "child:uncorrelated:child-b", input: 7 },
        { sessionID: "parent-1", kind: "cumulative", scope: "child:uncorrelated:child-a", input: 9 },
      ])
      item.router.dispose()
    })
  })
})
