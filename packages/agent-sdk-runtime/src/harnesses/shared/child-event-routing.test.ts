import { describe, expect, test } from "bun:test"
import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
import type { CompatEvent } from "../../compat-events"
import type { RuntimeEventEnvelopeInput } from "../../runtime-event-hub"
import {
  CHILD_EVENT_BUFFER_MAX_BYTES,
  CHILD_EVENT_BUFFER_MAX_COUNT,
  createChildEventRouter,
  type ChildProjectionTarget,
} from "./child-event-routing"
import { createTurnEventProjector, type RuntimeAppendSource } from "./turn-projection"

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
  const store = {
    appendEvent(event: { sessionId: string; agentSessionId?: string; payload: CompatEvent }) {
      journal.push(event)
      return { payload: event.payload }
    },
  }
  const parent = createTurnEventProjector({
    store,
    owner: { sessionId: "parent-1", getAgentSessionId: () => "provider-parent-1" },
    directory: "/repo",
    input: target("parent-1").input,
    assistantMessageId: "parent-assistant-1",
    created: 100,
    onEvent: (event) => parentCompat.push(event),
    onRuntimeEvent: (event) => runtime.push(event),
  })
  const router = createChildEventRouter({
    parent,
    createChildProjector: (child) => {
      childProjectors++
      return createTurnEventProjector({
        store,
        owner: { sessionId: child.sessionId, getAgentSessionId: child.getAgentSessionId },
        directory: "/repo",
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
})
