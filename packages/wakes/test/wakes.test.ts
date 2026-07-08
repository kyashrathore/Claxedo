import { describe, it, expect, beforeEach } from "vitest"
import {
  createWakes,
  SqliteWakeStore,
  BudgetError,
  type Wakes,
  type WakeResult,
  type Actor,
  type Budgets,
} from "../src/index"

type Spawned = { sessionId: string | null; result: WakeResult }

function harness(overrides?: {
  authorize?: (a: Actor, w: string) => boolean
  budgets?: Budgets
  spawnImpl?: (s: string | null, r: WakeResult) => void
}) {
  const clock = { t: 1_000_000 }
  const store = new SqliteWakeStore()
  const spawned: Spawned[] = []
  const wakes: Wakes = createWakes({
    store,
    now: () => clock.t,
    authorize: overrides?.authorize ?? (() => true),
    budgets: overrides?.budgets,
    computeNextRun: (_cron, after) => after + 60_000, // stub: "every minute"
    spawnTurn: async (sessionId, result) => {
      overrides?.spawnImpl?.(sessionId, result)
      spawned.push({ sessionId, result })
    },
  })
  return { clock, store, spawned, wakes }
}

const WS = "ws1"

describe("at trigger (time)", () => {
  it("fires a due one-shot via runDue and resumes the session", async () => {
    const { clock, wakes, spawned } = harness()
    wakes.schedule({ sessionId: "s1", workspaceId: WS, at: clock.t + 5_000, intent: { note: "chase key" } })

    expect((await wakes.runDue()).fired).toBe(0) // not due yet
    expect(spawned).toHaveLength(0)

    clock.t += 5_000
    expect((await wakes.runDue()).fired).toBe(1)
    expect(spawned).toEqual([{ sessionId: "s1", result: { trigger: "at", intent: { note: "chase key" } } }])

    expect((await wakes.runDue()).fired).toBe(0) // one-shot: does not re-fire
  })

  it("recurring (cron) enqueues the next occurrence deterministically", async () => {
    const { clock, wakes, store } = harness()
    const t0 = clock.t
    const { wakeId } = wakes.schedule({ sessionId: "s1", workspaceId: WS, cron: "* * * * *", intent: {} })
    expect(store.get(wakeId)!.fireAt).toBe(t0 + 60_000)

    clock.t = t0 + 60_000
    await wakes.runDue()

    const live = wakes.listForSession("s1").filter((w) => w.state === "pending")
    expect(live).toHaveLength(1)
    expect(live[0]!.fireAt).toBe(t0 + 120_000) // next occurrence, from the fired wake's own fireAt
  })
})

describe("on_approval trigger (authorized human)", () => {
  it("resolve resumes the session with the answer", async () => {
    const { wakes, spawned } = harness()
    const { token } = wakes.requestApproval({
      sessionId: "s1",
      workspaceId: WS,
      prompt: "Approve migration?",
      expiresAt: Date.now() + 60_000,
    })
    const outcome = await wakes.resolve(token, "approved, staging first", { userId: "priya" })
    expect(outcome).toEqual({ ok: true })
    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toEqual({
      sessionId: "s1",
      result: { trigger: "on_approval", answer: "approved, staging first", resolvedBy: { userId: "priya" } },
    })
  })

  it("rejects an unauthorized resolver, and a leaked token is inert", async () => {
    const { wakes, spawned } = harness({ authorize: (a) => a.userId === "priya" })
    const { token } = wakes.requestApproval({ sessionId: "s1", workspaceId: WS, prompt: "?", expiresAt: 9e15 })
    expect(await wakes.resolve(token, "yes", { userId: "mallory" })).toEqual({ ok: false, reason: "unauthorized" })
    expect(spawned).toHaveLength(0)
    expect(await wakes.resolve(token, "yes", { userId: "priya" })).toEqual({ ok: true })
  })

  it("reports not_found / already_resolved / too_late", async () => {
    const { clock, wakes } = harness()
    expect(await wakes.resolve("bogus", "x", { userId: "p" })).toEqual({ ok: false, reason: "not_found" })

    const a = wakes.requestApproval({ sessionId: "s1", workspaceId: WS, prompt: "?", expiresAt: clock.t + 1000 })
    await wakes.resolve(a.token, "yes", { userId: "p" })
    expect(await wakes.resolve(a.token, "yes", { userId: "p" })).toEqual({ ok: false, reason: "already_resolved" })

    const b = wakes.requestApproval({ sessionId: "s2", workspaceId: WS, prompt: "?", expiresAt: clock.t + 1000 })
    clock.t += 2000
    await wakes.runDue() // expires it
    expect(await wakes.resolve(b.token, "yes", { userId: "p" })).toEqual({ ok: false, reason: "too_late" })
  })
})

describe("on_event trigger (external)", () => {
  it("deliverEvent fires all sessions watching the key, with the payload", async () => {
    const { wakes, spawned } = harness()
    wakes.watch({ sessionId: "s1", workspaceId: WS, eventKey: "ci:pass:x", intent: { pr: 1 }, expiresAt: 9e15 })
    wakes.watch({ sessionId: "s2", workspaceId: WS, eventKey: "ci:pass:x", intent: { pr: 2 }, expiresAt: 9e15 })
    wakes.watch({ sessionId: "s3", workspaceId: WS, eventKey: "ci:pass:y", intent: {}, expiresAt: 9e15 })

    const { fired } = await wakes.deliverEvent("ci:pass:x", { sha: "abc" })
    expect(fired).toBe(2)
    expect(spawned.map((s) => s.sessionId).sort()).toEqual(["s1", "s2"])
    expect(spawned[0]!.result).toMatchObject({ trigger: "on_event", payload: { sha: "abc" } })
  })
})

describe("cancel + expiry", () => {
  it("cancel prevents a wake from firing", async () => {
    const { clock, wakes, spawned } = harness()
    const { wakeId } = wakes.schedule({ sessionId: "s1", workspaceId: WS, at: clock.t + 1000, intent: {} })
    wakes.cancel(wakeId)
    clock.t += 1000
    await wakes.runDue()
    expect(spawned).toHaveLength(0)
  })

  it("expiry fires a 'gave up' turn", async () => {
    const { clock, wakes, spawned } = harness()
    wakes.watch({ sessionId: "s1", workspaceId: WS, eventKey: "never", intent: { x: 1 }, expiresAt: clock.t + 500 })
    clock.t += 500
    await wakes.runDue()
    expect(spawned).toEqual([{ sessionId: "s1", result: { trigger: "at", intent: { x: 1 }, expired: true } }])
  })
})

describe("crash durability", () => {
  it("re-drives a firing row on recover() with no dropped result", async () => {
    let boom = true
    const { wakes, store, spawned } = harness({
      spawnImpl: () => {
        if (boom) {
          boom = false
          throw new Error("crash mid-fire")
        }
      },
    })
    const { token } = wakes.requestApproval({ sessionId: "s1", workspaceId: WS, prompt: "?", expiresAt: 9e15 })
    // resolve flips pending→firing, then the spawn throws → row stuck in 'firing'
    await expect(wakes.resolve(token, "approved", { userId: "priya" })).rejects.toThrow("crash mid-fire")
    expect(store.getByToken(token)!.state).toBe("firing")
    expect(spawned).toHaveLength(0)

    // boot sweep re-drives it — the answer survives via the persisted result
    const { recovered } = await wakes.recover()
    expect(recovered).toBe(1)
    expect(store.getByToken(token)!.state).toBe("fired")
    expect(spawned).toEqual([
      { sessionId: "s1", result: { trigger: "on_approval", answer: "approved", resolvedBy: { userId: "priya" } } },
    ])
  })

  it("runDue reclaims a firing 'at' wake whose lease lapsed", async () => {
    let boom = true
    const { clock, wakes, store, spawned } = harness({
      spawnImpl: () => {
        if (boom) {
          boom = false
          throw new Error("crash")
        }
      },
    })
    wakes.schedule({ sessionId: "s1", workspaceId: WS, at: clock.t, intent: { n: 1 } })
    await expect(wakes.runDue()).rejects.toThrow("crash") // claims then spawn throws → stuck firing
    const stuck = store.listFiring()
    expect(stuck).toHaveLength(1)

    clock.t += 60_000 // lease (30s default) lapses
    expect((await wakes.runDue()).fired).toBe(1)
    expect(spawned).toHaveLength(1)
    expect(store.get(stuck[0]!.id)!.state).toBe("fired")
  })

  it("the pending guard serializes fire vs expire (no double)", async () => {
    const { clock, wakes, spawned } = harness()
    const { token } = wakes.requestApproval({ sessionId: "s1", workspaceId: WS, prompt: "?", expiresAt: clock.t + 1 })
    // resolve wins the pending guard first
    expect(await wakes.resolve(token, "yes", { userId: "p" })).toEqual({ ok: true })
    // now overdue, but already fired → runDue must not expire/refire it
    clock.t += 10
    expect((await wakes.runDue()).fired).toBe(0)
    expect(spawned).toHaveLength(1)
  })
})

describe("idempotency + once", () => {
  it("schedule with the same idempotencyKey creates one wake", async () => {
    const { clock, wakes } = harness()
    const a = wakes.schedule({ workspaceId: WS, at: clock.t + 1, intent: {}, idempotencyKey: "k1" })
    const b = wakes.schedule({ workspaceId: WS, at: clock.t + 1, intent: {}, idempotencyKey: "k1" })
    expect(a.wakeId).toBe(b.wakeId)
  })

  it("once runs fn a single time and returns the recorded result on re-run", async () => {
    const { wakes } = harness()
    let calls = 0
    const run = () => wakes.once("s1", "open-pr:branch-x", async () => (++calls, { pr: 42 }))
    expect(await run()).toEqual({ pr: 42 })
    expect(await run()).toEqual({ pr: 42 })
    expect(calls).toBe(1)
  })
})

describe("budgets", () => {
  it("rejects over-max-live, over-horizon, and over-depth", async () => {
    const { clock, wakes } = harness({ budgets: { maxLiveWakes: 2, maxHorizonMs: 10_000, maxDepth: 2 } })
    wakes.schedule({ workspaceId: WS, at: clock.t + 1, intent: {} })
    wakes.schedule({ workspaceId: WS, at: clock.t + 1, intent: {} })
    expect(() => wakes.schedule({ workspaceId: WS, at: clock.t + 1, intent: {} })).toThrow(BudgetError)

    const fresh = harness({ budgets: { maxHorizonMs: 10_000, maxDepth: 2 } })
    expect(() =>
      fresh.wakes.schedule({ workspaceId: WS, at: fresh.clock.t + 999_999, intent: {} }),
    ).toThrow(/horizon/)
    expect(() => fresh.wakes.schedule({ workspaceId: WS, at: fresh.clock.t + 1, intent: {}, depth: 3 })).toThrow(
      /depth/,
    )
  })
})
