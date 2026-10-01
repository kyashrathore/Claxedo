import { expect, test } from "bun:test"
import type { AgentGoalMutationResult, RuntimeGoalSnapshot } from "@claxedo/agent-runtime-contract"
import type { SessionBroker } from "@claxedo/harness/contract"
import { FakeTransport } from "../../../workspace-runtime/src/test-support/fake-transport"
import { createHostFixture, controlledTurn, sessionCreate, tick, LOOPBACK_ORIGIN } from "../../../workspace-runtime/src/test-support/host-fixture"

function fixture(gracefulCancelMs = 5_000) {
  const brokers = new Map<string, SessionBroker>()
  const control = controlledTurn("s")
  const snapshots = new Map<string, RuntimeGoalSnapshot>()
  const cancellationCountsAtDisable: number[] = []
  let starts = 0
  let stop: AgentGoalMutationResult = { ok: true, goal: null }
  const transport = new FakeTransport({
    turn: () => control.events,
    beforeStart: async (input, broker) => { brokers.set(input.sessionId, broker) },
    capabilities: { goals: { implemented: true, available: true, actions: ["pause", "resume", "delete"], optionalFields: [], recovery: "blocked" } },
    goals: {
      read: async (session) => snapshots.get(session.binding.sessionId) ?? null,
      start: async (session, objective) => {
        starts++
        await tick()
        const goal: RuntimeGoalSnapshot = { sessionId: session.binding.sessionId, objective, status: "active", createdAt: 1, updatedAt: 1 }
        snapshots.set(goal.sessionId, goal)
        return { ok: true, goal }
      },
      pause: async (session) => ({ ok: true, goal: snapshots.get(session.binding.sessionId) ?? null }),
      resume: async () => ({ ok: true, goal: null }),
      delete: async (session) => { snapshots.delete(session.binding.sessionId); return { ok: true, goal: null } },
      stop: async () => { cancellationCountsAtDisable.push(transport.cancels.length); return stop },
    },
  })
  const f = createHostFixture({ transports: { pi: transport }, recovery: { budgets: { gracefulCancelMs } } })
  return { ...f, transport, control, snapshots, brokers, cancellationCountsAtDisable, starts: () => starts, setStop: (value: AgentGoalMutationResult) => { stop = value } }
}

test("concurrent Goal starts serialize and only one provider start can succeed", async () => {
  const f = fixture()
  try {
    await f.runtime.sessions.create(sessionCreate({ id: "s" }))
    const outcomes = await Promise.allSettled([1, 2].map(() => f.runtime.goals.start({ sessionId: "s", objective: "ship" })))
    expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1)
    expect(outcomes.find((value) => value.status === "rejected")).toMatchObject({ reason: { code: "goal_already_exists" } })
    expect(f.starts()).toBe(1)
  } finally { await f.dispose() }
})

test("Goal snapshots dedupe per session, update on change, and publish again after deletion", async () => {
  const f = fixture()
  try {
    for (const id of ["s", "other"]) await f.runtime.sessions.create(sessionCreate({ id }))
    const events = f.runtime.events.subscribe()[Symbol.asyncIterator]()
    for (const id of ["s", "other"]) {
      await f.runtime.goals.start({ sessionId: id, objective: "ship" })
      expect((await events.next()).value?.payload).toMatchObject({ type: "goal-updated", sessionId: id })
      await f.runtime.goals.pause(id)
    }
    f.snapshots.set("s", { ...f.snapshots.get("s")!, status: "complete" })
    await f.runtime.goals.pause("s")
    expect((await events.next()).value?.payload).toMatchObject({ type: "goal-updated", goal: { status: "complete" } })
    await f.runtime.sessions.delete("s")
    await f.runtime.sessions.create(sessionCreate({ id: "s" }))
    f.snapshots.delete("s")
    await f.runtime.goals.start({ sessionId: "s", objective: "ship" })
    expect((await events.next()).value?.payload).toMatchObject({ type: "goal-updated", goal: { status: "active" } })
    await events.return?.()
  } finally { await f.dispose() }
})

test("failed Goal disable leaves the turn admitted and returns the provider failure untouched", async () => {
  const f = fixture()
  try {
    await f.runtime.sessions.create(sessionCreate({ id: "s" }))
    await f.runtime.turns.start({ sessionId: "s", text: "work", origin: LOOPBACK_ORIGIN })
    const failure = { ok: false as const, status: "failed" as const, message: "provider refused" }
    f.setStop(failure)
    expect(await f.runtime.goals.stop("s")).toBe(failure)
    expect(f.transport.cancels).toEqual([])
    expect(f.store.getSession("s")?.status).toBe("busy")
    await expect(f.runtime.turns.start({ sessionId: "s", text: "next", origin: LOOPBACK_ORIGIN })).rejects.toThrow()
  } finally { f.control.finish(); await f.dispose() }
})

test("Goal stop without an active turn returns the disabling result without cancellation", async () => {
  const f = fixture()
  try {
    await f.runtime.sessions.create(sessionCreate({ id: "s" }))
    const result = { ok: true as const, goal: null }
    f.setStop(result)
    expect(await f.runtime.goals.stop("s")).toBe(result)
    expect(f.transport.cancels).toEqual([])
  } finally { await f.dispose() }
})

test("Goal stop does not report success while its producer is still running", async () => {
  const f = fixture()
  try {
    await f.runtime.sessions.create(sessionCreate({ id: "s" }))
    await f.runtime.turns.start({ sessionId: "s", text: "work", origin: LOOPBACK_ORIGIN })
    let settled = false
    const stopping = f.runtime.goals.stop("s").then((result) => { settled = true; return result })
    await tick()
    expect(settled).toBe(false)
    expect(f.cancellationCountsAtDisable).toEqual([0])
    expect(f.transport.cancels).toHaveLength(1)
    f.control.finish()
    expect(await stopping).toEqual({ ok: true, goal: null })
    expect(f.transport.cancels).toHaveLength(1)
  } finally { f.control.finish(); await f.dispose() }
})

test("disposal awaits an admitted provider Goal producer before returning", async () => {
  const f = fixture()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let settled: Promise<unknown> | undefined
  try {
    await f.runtime.sessions.create({ ...sessionCreate({ id: "s" }), agent: "build", model: { providerID: "test", modelID: "test" } })
    const admission = await f.brokers.get("s")!.admitProviderTurn({ reason: "goal" }, async function* () {
      await gate
      yield { event: { type: "finish", sessionId: "s" } }
    })
    if (!admission.admitted) throw new Error("Provider turn must be admitted")
    settled = admission.settled
    let disposed = false
    const disposal = f.runtime.dispose().then(() => { disposed = true })
    await tick()
    expect(disposed).toBe(false)
    release()
    await settled
    await disposal
  } finally { release(); await settled; await f.dispose() }
})

test("Goal stop disables continuation but reports a deadline failure while its producer remains live", async () => {
  const f = fixture(40)
  try {
    await f.runtime.sessions.create(sessionCreate({ id: "s" }))
    await f.runtime.turns.start({ sessionId: "s", text: "work", origin: LOOPBACK_ORIGIN })
    const result = await f.runtime.goals.stop("s")
    expect(result).toMatchObject({ ok: false, status: "failed", message: expect.stringContaining("deadline") })
    expect(f.transport.cancels).toHaveLength(1)
    expect(f.store.getSession("s")?.status).toBe("busy")
    expect(f.store.readTurnAuthority("s")).toBeDefined()
    await expect(f.runtime.turns.start({ sessionId: "s", text: "replacement", origin: LOOPBACK_ORIGIN })).rejects.toThrow()
  } finally { f.control.finish(); await f.dispose() }
})

test("Goal stop drains a provider-admitted turn using its captured assistant identity", async () => {
  const f = fixture()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  try {
    await f.runtime.sessions.create({ ...sessionCreate({ id: "s" }), agent: "build", model: { providerID: "test", modelID: "test" } })
    const admitted = await f.brokers.get("s")!.admitProviderTurn({ reason: "goal" }, async function* () {
      await gate
      yield { event: { type: "finish", sessionId: "s" } }
    })
    if (!admitted.admitted) throw new Error("Provider turn must be admitted")
    let stopped = false
    const stopping = f.runtime.goals.stop("s").then((result) => { stopped = true; return result })
    await tick()
    expect(stopped).toBe(false)
    expect(f.transport.cancels[0]?.turn).toEqual(admitted.turn)
    release()
    expect(await stopping).toEqual({ ok: true, goal: null })
    expect(await admitted.settled).toEqual({ state: "completed" })
    expect(f.runtime.recovery.inspect("s").failures).toEqual([])
    expect(f.store.readTurnAuthority("s")).toBeUndefined()
  } finally { release(); await f.dispose() }
})
