import { describe, expect, test } from "bun:test"
import type { AgentRuntimeEvent, RuntimeUsageObservation, AgentPresentationEvent } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/helpers/guards"
import type { RuntimeEventEnvelopeInput } from "./runtime-event-hub"
import { createChildEventRouter, type ChildProjectionTarget } from "./child-event-routing"
import type { ChildRoute } from "./child-routes"
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

function fixture() {
  const journal: Array<{ sessionId: string; agentSessionId?: string; payload: AgentPresentationEvent }> = []
  const parentEvents: AgentPresentationEvent[] = []
  const childEvents: AgentPresentationEvent[] = []
  const runtime: RuntimeEventEnvelopeInput[] = []
  const diagnostics: AgentRuntimeEvent[] = []
  const routes = new Map<string, ChildRoute>()
  const targetsAsked: string[] = []
  let childProjectors = 0
  const appendEvent = (event: { sessionId: string; agentSessionId?: string; payload: AgentPresentationEvent }) => {
    journal.push(event)
    return { payload: event.payload }
  }
  const parent = testTurnProjector({
    appendEvent,
    owner: { sessionId: "parent-1", getAgentSessionId: () => "provider-parent-1" },
    input: target("parent-1").input,
    assistantMessageId: "parent-assistant-1",
    onEvent: (event) => parentEvents.push(event),
    onRuntimeEvent: (event) => {
      runtime.push(event)
      if (event.payload.type === "diagnostic") diagnostics.push(event.payload)
    },
  })
  const router = createChildEventRouter({
    parent,
    resolve: (correlationKey) => routes.get(correlationKey) ?? { kind: "unbound" },
    childTarget: (route) => {
      targetsAsked.push(route.assistantMessageId)
      return { ...target(route.childSessionId), assistantMessageId: route.assistantMessageId }
    },
    createChildProjector: (child) => {
      childProjectors++
      return testTurnProjector({
        appendEvent,
        owner: { sessionId: child.sessionId, getAgentSessionId: child.getAgentSessionId },
        input: child.input,
        assistantMessageId: child.assistantMessageId,
        created: child.created,
        onEvent: (event) => childEvents.push(event),
        onRuntimeEvent: (event) => runtime.push(event),
      })
    },
  })
  const bind = (correlationKey: string, childSessionId = "child-1", assistantMessageId = `${childSessionId}-assistant-1`) =>
    routes.set(correlationKey, { kind: "bound", childSessionId, assistantMessageId })
  return { router, journal, parentEvents, childEvents, runtime, diagnostics, routes, bind, targetsAsked, childProjectors: () => childProjectors }
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

function meteredOn(events: AgentPresentationEvent[]) {
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
    item.bind("thread-1")
    item.router.project({ type: "text-delta", delta: "child text" }, source, { kind: "child", correlationKey: "thread-1" })

    expect(item.journal.length).toBeGreaterThan(0)
    expect(item.journal.every((event) => event.sessionId === "child-1" && event.agentSessionId === "provider-child-1")).toBe(true)
    expect(item.parentEvents).toEqual([])
    expect(item.childEvents.length).toBeGreaterThan(0)
    expect(item.runtime.every((event) => event.sessionId === "child-1" && event.agentSessionId === "provider-child-1")).toBe(true)
  })

  test("reads the binding when each event arrives, so a child bound after an earlier event receives the later ones", () => {
    const item = fixture()
    item.router.project({ type: "text-delta", delta: "before binding" }, source, { kind: "child", correlationKey: "thread-1" })
    item.bind("thread-1")
    item.router.project({ type: "text-delta", delta: "after binding" }, source, { kind: "child", correlationKey: "thread-1" })

    expect(item.childEvents.flatMap((event) => event.type === "message.part.delta" ? [event.properties.delta] : [])).toEqual(["after binding"])
    expect(JSON.stringify(item.journal)).not.toContain("before binding")
    expect(diagnosticDetails(item.diagnostics)).toEqual([{ eventType: "text-delta", correlationKey: "thread-1" }])
  })

  test("drops each event the store cannot route, journaling only one diagnostic on the parent", () => {
    const item = fixture()
    item.routes.set("finished", { kind: "finished", childSessionId: "child-1", assistantMessageId: "child-1-assistant-1" })
    item.router.project({ type: "text-delta", delta: "lost" }, source, { kind: "child", correlationKey: "unknown" })
    item.router.project({ type: "text-delta", delta: "late" }, source, { kind: "child", correlationKey: "finished" })
    item.router.project({ type: "text-delta", delta: "uncorrelated" }, source, { kind: "child" })

    expect(item.journal.map((event) => event.payload.type)).toEqual(["runtime.diagnostic", "runtime.diagnostic", "runtime.diagnostic"])
    expect(item.childEvents).toEqual([])
    expect(diagnosticCodes(item.diagnostics)).toEqual([
      "child_event_route_unbound",
      "child_event_route_finished",
      "child_event_route_uncorrelated",
    ])
  })

  test("aliases multiple correlation keys to one lazily created child projector", () => {
    const item = fixture()
    item.bind("spawn")
    item.bind("interaction")
    expect(item.childProjectors()).toBe(0)
    item.router.project({ type: "text-delta", delta: "spawn" }, source, { kind: "child", correlationKey: "spawn" })
    item.router.project({ type: "text-delta", delta: "interaction" }, source, { kind: "child", correlationKey: "interaction" })

    expect(item.childProjectors()).toBe(1)
    expect(item.journal.every((event) => event.sessionId === "child-1")).toBe(true)
  })

  test("a child's later turn gets its own projector under the assistant message the store now names", () => {
    const item = fixture()
    item.bind("toolu_agent", "child-1", "turn-1")
    item.router.project({ type: "text-delta", delta: "first run" }, source, { kind: "child", correlationKey: "toolu_agent" })
    item.bind("toolu_agent", "child-1", "turn-2")
    item.router.project({ type: "text-delta", delta: "resumed run" }, source, { kind: "child", correlationKey: "toolu_agent" })

    expect(item.targetsAsked).toEqual(["turn-1", "turn-2"])
    expect(item.childProjectors()).toBe(2)
  })

  test("the router refuses events once its turn is disposed", () => {
    const item = fixture()
    item.router.dispose()
    expect(() => item.router.project({ type: "text-delta", delta: "late" }, source)).toThrow("disposed")
  })

  describe("usage a dropped child would lose", () => {
    test("reaches the parent turn in the child's own scope, while the child's transcript is dropped", () => {
      const item = fixture()
      const child = { kind: "child" as const, correlationKey: "late" }
      item.router.project({ type: "text-delta", delta: "child text" }, source, child)
      item.router.project(usage(10), source, child)
      item.router.project(usage(3, { kind: "delta", providerObservationId: "step-1" }), source, child)
      item.router.project(usage(7, { scope: "thread-late:turn-1" }), source, child)

      expect(meteredOn(item.parentEvents)).toEqual([
        { sessionID: "parent-1", kind: "cumulative", scope: "child:late", input: 10 },
        { sessionID: "parent-1", kind: "delta", scope: "child:late", input: 3 },
        { sessionID: "parent-1", kind: "cumulative", scope: "thread-late:turn-1", input: 7 },
      ])
      expect(JSON.stringify(item.journal)).not.toContain("child text")
      expect(item.childEvents).toEqual([])
    })

    test("keeps metering on the parent once a rolled-up correlation binds, so its cumulative is counted once", () => {
      const item = fixture()
      item.router.project(usage(10), source, { kind: "child", correlationKey: "late" })
      item.bind("late")
      item.router.project({ type: "text-delta", delta: "bound text" }, source, { kind: "child", correlationKey: "late" })
      item.router.project(usage(40), source, { kind: "child", correlationKey: "late" })

      expect(meteredOn(item.parentEvents)).toEqual([
        { sessionID: "parent-1", kind: "cumulative", scope: "child:late", input: 10 },
        { sessionID: "parent-1", kind: "cumulative", scope: "child:late", input: 40 },
      ])
      expect(meteredOn(item.childEvents)).toEqual([])
      expect(JSON.stringify(item.childEvents)).toContain("bound text")
    })

    test("keeps two uncorrelated children apart by the provider session each reports from", () => {
      const item = fixture()
      item.router.project(usage(5, { nativeSessionId: "child-a" }), source, { kind: "child" })
      item.router.project(usage(7, { nativeSessionId: "child-b" }), source, { kind: "child" })
      item.router.project(usage(9, { nativeSessionId: "child-a" }), source, { kind: "child" })

      expect(meteredOn(item.parentEvents)).toEqual([
        { sessionID: "parent-1", kind: "cumulative", scope: "child:uncorrelated:child-a", input: 5 },
        { sessionID: "parent-1", kind: "cumulative", scope: "child:uncorrelated:child-b", input: 7 },
        { sessionID: "parent-1", kind: "cumulative", scope: "child:uncorrelated:child-a", input: 9 },
      ])
    })
  })
})
