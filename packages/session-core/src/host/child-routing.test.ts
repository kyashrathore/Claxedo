import { expect, test } from "bun:test"
import type { AgentRuntimeEvent, SubagentObservation } from "@claxedo/agent-runtime-contract"
import type { RoutedEvent, SessionBroker } from "@claxedo/harness/contract"
import { FakeTransport } from "../test-support/fake-transport"
import { createHostFixture, controlledTurn, sessionCreate, until, LOOPBACK_ORIGIN, type HostFixture } from "../test-support/host-fixture"

const spawn = (id: string, mode: "foreground" | "background", status: SubagentObservation["status"] = "running"): SubagentObservation => ({
  observationId: `${id}:${status}`, providerId: id, providerKind: "claude-agent", toolCallId: id, status, mode, transcript: { kind: "messages" },
})

const childText = (correlationKey: string, delta: string): RoutedEvent => ({ event: { type: "text-delta", delta }, route: { kind: "child", correlationKey } })

const fenced = (token: number) => ({ valid: () => true, fencingToken: () => token, proof: () => "turn-lease" })

function journal(f: HostFixture, sessionId: string) {
  return f.store.database().prepare<{ kind: string; type: string; payload_json: string }>(
    "SELECT kind, type, payload_json FROM runtime_journal WHERE session_id = ? ORDER BY seq").all(sessionId)
}

function diagnosticCodes(f: HostFixture, sessionId: string) {
  return journal(f, sessionId).filter((row) => row.type === "runtime.diagnostic").map((row) => JSON.parse(row.payload_json).properties.code)
}

test("a child moved to the background in one prompted turn keeps receiving its frames in the parent's next turn", async () => {
  const controls = [controlledTurn("parent"), controlledTurn("parent")]
  const second: RoutedEvent[] = []
  const transport = new FakeTransport({ turn: () => {
    const index = transport.turns.length - 1
    if (index === 0) return controls[0].events
    return (async function* () {
      for (const event of second) yield event
      yield* controls[1].events
    })()
  } })
  const f = createHostFixture({ transports: { pi: transport } })
  try {
    await f.runtime.sessions.create(sessionCreate({ id: "parent" }))
    await f.runtime.turns.start({ sessionId: "parent", text: "first", origin: LOOPBACK_ORIGIN, admission: fenced(1) })
    await until(() => transport.turns.length === 1)
    const child = await transport.turns[0].broker.observeSubagent(spawn("toolu_agent", "foreground"))
    transport.turns[0].broker.associateChild("toolu_agent", child!)
    await transport.turns[0].broker.observeSubagent({ ...spawn("toolu_agent", "background"), observationId: "backgrounded" })
    controls[0].finish()
    ;(await f.runtime.turns.whenIdle("parent")).abandon()
    second.push(childText("toolu_agent", "still working in the background"))
    await f.runtime.turns.start({ sessionId: "parent", text: "second", origin: LOOPBACK_ORIGIN, admission: fenced(2) })
    await until(() => transport.turns.length === 2)
    controls[1].finish()
    ;(await f.runtime.turns.whenIdle("parent")).abandon()

    expect(JSON.stringify(journal(f, child!.sessionId))).toContain("still working in the background")
    expect(diagnosticCodes(f, "parent")).toEqual([])
    expect(f.store.getSession("parent")?.lastTurn?.status).toBe("completed")
  } finally { for (const control of controls) control.finish(); await f.dispose() }
})

test("a prompted turn drops a frame for an unbound or finished child with one diagnostic and still completes", async () => {
  const control = controlledTurn("parent")
  const routed: RoutedEvent[] = []
  const transport = new FakeTransport({ turn: () => (async function* () {
    await until(() => routed.length === 2)
    for (const event of routed) yield event
    yield* control.events
  })() })
  const f = createHostFixture({ transports: { pi: transport } })
  try {
    await f.runtime.sessions.create(sessionCreate({ id: "parent" }))
    await f.runtime.turns.start({ sessionId: "parent", text: "work", origin: LOOPBACK_ORIGIN })
    await until(() => transport.turns.length === 1)
    const broker = transport.turns[0].broker
    const child = await broker.observeSubagent(spawn("toolu_done", "foreground"))
    broker.associateChild("toolu_done", child!)
    await broker.observeSubagent(spawn("toolu_done", "foreground", "completed"))
    routed.push(childText("toolu_01STm6g5Pds1uf6iSBzu7sJb", "heartbeat"), childText("toolu_done", "late"))
    control.finish()
    ;(await f.runtime.turns.whenIdle("parent")).abandon()

    expect(diagnosticCodes(f, "parent")).toEqual(["child_event_route_unbound", "child_event_route_finished"])
    expect(JSON.stringify(journal(f, child!.sessionId))).not.toContain("late")
    expect(f.store.getSession("parent")?.lastTurn?.status).toBe("completed")
  } finally { control.finish(); await f.dispose() }
})

test("a child spawned inside a provider turn runs its own turn on the session's model and settles from its terminal", async () => {
  const brokers = new Map<string, SessionBroker>()
  const transport = new FakeTransport({ beforeStart: async (input, broker) => { brokers.set(input.sessionId, broker) } })
  const f = createHostFixture({ transports: { pi: transport } })
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  try {
    await f.runtime.sessions.create({ ...sessionCreate({ id: "s" }), agent: "build", model: { providerID: "test", modelID: "session-model" } })
    await f.runtime.turns.start({ sessionId: "s", text: "hello", origin: LOOPBACK_ORIGIN })
    ;(await f.runtime.turns.whenIdle("s")).abandon()
    let childSessionId: string | undefined
    const admission = await brokers.get("s")!.admitProviderTurn({ reason: "goal" }, async function* (broker) {
      const child = await broker.observeSubagent(spawn("toolu_goal_agent", "foreground"))
      childSessionId = child!.sessionId
      broker.associateChild("toolu_goal_agent", child!)
      yield childText("toolu_goal_agent", "child work inside the goal")
      await gate
      await broker.observeSubagent(spawn("toolu_goal_agent", "foreground", "completed"))
      yield { event: { type: "finish", sessionId: "s" } satisfies AgentRuntimeEvent }
    })
    if (!admission.admitted) throw new Error("Provider turn must be admitted")
    await until(() => childSessionId !== undefined && f.store.getSession(childSessionId)?.status === "busy", "child turn started")
    const started = journal(f, childSessionId!).find((row) => row.kind === "control" && row.type === "turn.start")
    expect(JSON.parse(started!.payload_json).model).toEqual({ providerID: "test", modelID: "session-model" })
    release()
    await admission.settled
    expect(JSON.stringify(journal(f, childSessionId!))).toContain("child work inside the goal")
    expect(f.store.getSession(childSessionId!)?.lastTurn?.status).toBe("completed")
    expect(f.store.readTurnAuthority(childSessionId!)).toBeUndefined()
  } finally { release(); await f.dispose() }
})

test("an agent resumed by a later call reopens its child session and receives frames keyed by its original spawn call", async () => {
  const controls = [controlledTurn("parent"), controlledTurn("parent")]
  const second: RoutedEvent[] = []
  const transport = new FakeTransport({ turn: () => {
    const index = transport.turns.length - 1
    if (index === 0) return controls[0].events
    return (async function* () {
      await until(() => second.length > 0)
      for (const event of second) yield event
      yield* controls[1].events
    })()
  } })
  const f = createHostFixture({ transports: { pi: transport } })
  const task = (toolCallId: string, status: SubagentObservation["status"]): SubagentObservation => ({
    observationId: `claude:task:${toolCallId}:${status}`, stableCorrelationId: "ab03639cdfec8b10f", toolCallId,
    providerKind: "claude-agent", status, mode: "background", transcript: { kind: "messages" },
  })
  try {
    await f.runtime.sessions.create(sessionCreate({ id: "parent" }))
    await f.runtime.turns.start({ sessionId: "parent", text: "first", origin: LOOPBACK_ORIGIN })
    await until(() => transport.turns.length === 1)
    const first = transport.turns[0].broker
    const child = await first.observeSubagent(task("toolu_01CM7rPr5fxA7N9D3aD9vJMR", "running"))
    first.associateChild("toolu_01CM7rPr5fxA7N9D3aD9vJMR", child!)
    await first.observeSubagent(task("toolu_01CM7rPr5fxA7N9D3aD9vJMR", "completed"))
    controls[0].finish()
    ;(await f.runtime.turns.whenIdle("parent")).abandon()

    await f.runtime.turns.start({ sessionId: "parent", text: "resume lane A", origin: LOOPBACK_ORIGIN })
    await until(() => transport.turns.length === 2)
    const next = transport.turns[1].broker
    const resumed = await next.observeSubagent(task("toolu_01LxqZ8zxkTpU8LH8gBdeU9S", "running"))
    next.associateChild("toolu_01LxqZ8zxkTpU8LH8gBdeU9S", resumed!)
    second.push(childText("toolu_01CM7rPr5fxA7N9D3aD9vJMR", "Picking up where I left off."))
    await until(() => JSON.stringify(journal(f, child!.sessionId)).includes("Picking up where I left off."), "resumed frame delivered")
    await next.observeSubagent(task("toolu_01LxqZ8zxkTpU8LH8gBdeU9S", "completed"))
    controls[1].finish()
    ;(await f.runtime.turns.whenIdle("parent")).abandon()

    expect(resumed?.sessionId).toBe(child!.sessionId)
    expect(resumed?.assistantMessageId).not.toBe(child!.assistantMessageId)
    expect(diagnosticCodes(f, "parent")).toEqual([])
    expect(f.store.getSession(child!.sessionId)?.lastTurn?.status).toBe("completed")
  } finally { for (const control of controls) control.finish(); await f.dispose() }
})
