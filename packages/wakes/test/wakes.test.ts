import { describe, it, expect } from "vitest"
import { createWakes, BudgetError, type Wakes, type WakeResult, type Actor, type Budgets } from "../src/index"
import { SqliteWakeStore } from "../src/sqlite"

type Spawned = { sessionId: string | null; result: WakeResult }

/** Stable ordering for nullable identifiers collected out of firing order. */
const byText = (a: string | null, b: string | null) => (a ?? "").localeCompare(b ?? "")

function harness(overrides?: {
  authorize?: (a: Actor, w: string) => boolean | Promise<boolean>
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
    await wakes.schedule({ sessionId: "s1", workspaceId: WS, at: clock.t + 5_000, intent: { note: "chase key" } })

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
    const { wakeId } = await wakes.schedule({ sessionId: "s1", workspaceId: WS, cron: "* * * * *", intent: {} })
    expect((await store.get(wakeId))!.fireAt).toBe(t0 + 60_000)

    clock.t = t0 + 60_000
    await wakes.runDue()

    const live = (await wakes.listForSession("s1")).filter((w) => w.state === "pending")
    expect(live).toHaveLength(1)
    expect(live[0]!.fireAt).toBe(t0 + 120_000) // next occurrence, from the fired wake's own fireAt
  })
})

describe("on_approval trigger (authorized human)", () => {
  it.each([-1, 0, 1])("checks the deadline without a sweeper at expiry %+dms", async (offset) => {
    const { clock, wakes, spawned } = harness()
    const expiresAt = clock.t + 1000
    const { token } = await wakes.requestApproval({ sessionId: "s1", workspaceId: WS, prompt: "Approve?", expiresAt })
    clock.t = expiresAt + offset
    expect(await wakes.resolve(token, "yes", { userId: "owner" })).toEqual(
      offset < 0 ? { ok: true } : { ok: false, reason: "too_late" },
    )
    expect(spawned).toHaveLength(offset < 0 ? 1 : 0)
  })

  it("does not approve after the deadline passes during authorization", async () => {
    const { clock, wakes, spawned } = harness({ authorize: async () => {
      await Promise.resolve()
      clock.t += 1000
      return true
    } })
    const { token } = await wakes.requestApproval({
      sessionId: "s1", workspaceId: WS, prompt: "Approve?", expiresAt: clock.t + 1000,
    })
    expect(await wakes.resolve(token, "yes", { userId: "owner" })).toEqual({ ok: false, reason: "too_late" })
    expect(spawned).toHaveLength(0)
    // The sweeper still owns the one expiry notification.
    await wakes.runDue()
    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.result).toMatchObject({ expired: true })
  })

  it("resolve resumes the session with the answer", async () => {
    const { wakes, spawned } = harness()
    const { token } = await wakes.requestApproval({
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
    const { token } = await wakes.requestApproval({ sessionId: "s1", workspaceId: WS, prompt: "?", expiresAt: 9e15 })
    expect(await wakes.resolve(token, "yes", { userId: "mallory" })).toEqual({ ok: false, reason: "unauthorized" })
    expect(spawned).toHaveLength(0)
    expect(await wakes.resolve(token, "yes", { userId: "priya" })).toEqual({ ok: true })
  })

  it("two concurrent resolves elect exactly one winner", async () => {
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    // Parking authorize lets both resolvers observe `pending` before either
    // reaches the CAS — the window a double-fire would appear in.
    const { wakes, spawned } = harness({
      authorize: async () => {
        await gate
        return true
      },
    })
    const { token } = await wakes.requestApproval({
      sessionId: "s1",
      workspaceId: WS,
      prompt: "?",
      expiresAt: 9e15,
    })
    const a = wakes.resolve(token, "yes", { userId: "a" })
    const b = wakes.resolve(token, "yes", { userId: "b" })
    await new Promise((r) => setTimeout(r, 25))
    releaseGate()
    const outcomes = await Promise.all([a, b])
    expect(outcomes.filter((o) => o.ok)).toEqual([{ ok: true }])
    expect(outcomes.filter((o) => !o.ok)).toEqual([{ ok: false, reason: "already_resolved" }])
    expect(spawned).toHaveLength(1)
  })

  it("reports not_found / already_resolved / too_late", async () => {
    const { clock, wakes } = harness()
    expect(await wakes.resolve("bogus", "x", { userId: "p" })).toEqual({ ok: false, reason: "not_found" })

    const a = await wakes.requestApproval({ sessionId: "s1", workspaceId: WS, prompt: "?", expiresAt: clock.t + 1000 })
    await wakes.resolve(a.token, "yes", { userId: "p" })
    expect(await wakes.resolve(a.token, "yes", { userId: "p" })).toEqual({ ok: false, reason: "already_resolved" })

    const b = await wakes.requestApproval({ sessionId: "s2", workspaceId: WS, prompt: "?", expiresAt: clock.t + 1000 })
    clock.t += 2000
    await wakes.runDue() // expires it
    expect(await wakes.resolve(b.token, "yes", { userId: "p" })).toEqual({ ok: false, reason: "too_late" })
  })
})

describe("on_event trigger (external)", () => {
  it.each([-1, 0, 1])("checks the deadline without a sweeper at expiry %+dms", async (offset) => {
    const { clock, wakes, spawned } = harness()
    const expiresAt = clock.t + 1000
    await wakes.watch({ sessionId: "s1", workspaceId: WS, eventKey: "event", intent: {}, expiresAt })
    clock.t = expiresAt + offset
    expect(await wakes.deliverEvent({ workspaceId: WS, eventKey: "event", payload: {} })).toEqual({
      fired: offset < 0 ? 1 : 0,
    })
    expect(spawned).toHaveLength(offset < 0 ? 1 : 0)
  })

  it("compares the stored deadline atomically even if the earlier read returned an unexpired wake", async () => {
    const { clock, store, wakes, spawned } = harness()
    const { wakeId } = await wakes.watch({
      sessionId: "s1", workspaceId: WS, eventKey: "event", intent: {}, expiresAt: clock.t + 1000,
    })
    const find = store.findPendingByEventKey.bind(store)
    store.findPendingByEventKey = async (workspaceId, key) => {
      const pending = await find(workspaceId, key)
      store.db.prepare("UPDATE wakes SET expires_at = ? WHERE id = ?").run(clock.t, wakeId)
      return pending
    }
    expect(await wakes.deliverEvent({ workspaceId: WS, eventKey: "event", payload: {} })).toEqual({ fired: 0 })
    expect(spawned).toHaveLength(0)
    expect((await store.get(wakeId))?.state).toBe("pending")
  })

  it("deliverEvent fires all sessions watching the key, with the payload", async () => {
    const { wakes, spawned } = harness()
    await wakes.watch({ sessionId: "s1", workspaceId: WS, eventKey: "ci:pass:x", intent: { pr: 1 }, expiresAt: 9e15 })
    await wakes.watch({ sessionId: "s2", workspaceId: WS, eventKey: "ci:pass:x", intent: { pr: 2 }, expiresAt: 9e15 })
    await wakes.watch({ sessionId: "s3", workspaceId: WS, eventKey: "ci:pass:y", intent: {}, expiresAt: 9e15 })

    const { fired } = await wakes.deliverEvent({ workspaceId: WS, eventKey: "ci:pass:x", payload: { sha: "abc" } })
    expect(fired).toBe(2)
    expect(spawned.map((s) => s.sessionId).sort(byText)).toEqual(["s1", "s2"])
    expect(spawned[0]!.result).toMatchObject({ trigger: "on_event", payload: { sha: "abc" } })
  })

  it("delivers only to the addressed workspace when another workspace watches the same key", async () => {
    const { wakes, store, spawned } = harness()
    await wakes.watch({
      sessionId: "s1", workspaceId: "ws-a", eventKey: "ci:pass:x", intent: { pr: 1 }, expiresAt: 9e15,
    })
    const stray = await wakes.watch({
      sessionId: "s2", workspaceId: "ws-b", eventKey: "ci:pass:x", intent: { pr: 2 }, expiresAt: 9e15,
    })

    const { fired } = await wakes.deliverEvent({
      workspaceId: "ws-a",
      eventKey: "ci:pass:x",
      payload: { sha: "tenant-a-secret" },
    })
    expect(fired).toBe(1)
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.sessionId).toBe("s1")
    expect(JSON.stringify(spawned[0]!.result)).toContain("tenant-a-secret")
    // The colliding watch stays pending — the payload text never reached ws-b.
    expect((await store.get(stray.wakeId))!.state).toBe("pending")
    expect(await wakes.deliverEvent({ workspaceId: "ws-b", eventKey: "ci:pass:x", payload: {} })).toEqual({ fired: 1 })
  })
})

describe("cancel + expiry", () => {
  it("a lane-specific claim never fires expired work: its own run terminalizes the row instead", async () => {
    const { clock, wakes, store, spawned } = harness()
    const { wakeId } = await wakes.schedule({
      sessionId: "s1", workspaceId: WS, serialKey: "lane", at: clock.t + 500, expiresAt: clock.t + 1000, intent: {},
    })
    clock.t += 1000
    expect(await wakes.runDue("lane")).toEqual({ fired: 1 })
    expect((await store.get(wakeId))!.state).toBe("expired")
    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.result).toMatchObject({ expired: true })
  })

  it("cancel prevents a wake from firing", async () => {
    const { clock, wakes, spawned } = harness()
    const { wakeId } = await wakes.schedule({ sessionId: "s1", workspaceId: WS, at: clock.t + 1000, intent: {} })
    await wakes.cancel(wakeId)
    clock.t += 1000
    await wakes.runDue()
    expect(spawned).toHaveLength(0)
  })

  it("expiry fires a 'gave up' turn", async () => {
    const { clock, wakes, spawned } = harness()
    await wakes.watch({
      sessionId: "s1",
      workspaceId: WS,
      eventKey: "never",
      intent: { x: 1 },
      expiresAt: clock.t + 500,
    })
    clock.t += 500
    await wakes.runDue()
    expect(spawned).toEqual([{ sessionId: "s1", result: { trigger: "at", intent: { x: 1 }, expired: true } }])
  })
})

describe("crash durability", () => {
  it("re-drives a firing row on recover() with no dropped result", async () => {
    let boom = true
    const { clock, wakes, store, spawned } = harness({
      spawnImpl: () => {
        if (boom) {
          boom = false
          throw new Error("crash mid-fire")
        }
      },
    })
    const { token } = await wakes.requestApproval({ sessionId: "s1", workspaceId: WS, prompt: "?", expiresAt: 9e15 })
    // resolve flips pending→firing, then the spawn throws → row stuck in 'firing'
    await expect(wakes.resolve(token, "approved", { userId: "priya" })).rejects.toThrow("crash mid-fire")
    expect((await store.getByToken(token))!.state).toBe("firing")
    expect(spawned).toHaveLength(0)

    // Once the abandoned lease lapses, the boot sweep re-drives it — the
    // answer survives via the persisted result.
    clock.t += 30_000
    const { recovered } = await wakes.recover()
    expect(recovered).toBe(1)
    expect((await store.getByToken(token))!.state).toBe("fired")
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
    await wakes.schedule({ sessionId: "s1", workspaceId: WS, at: clock.t, intent: { n: 1 } })
    await expect(wakes.runDue()).rejects.toThrow("crash") // claims then spawn throws → stuck firing
    const stuck = await store.listFiring()
    expect(stuck).toHaveLength(1)

    clock.t += 60_000 // lease (30s default) lapses
    expect((await wakes.runDue()).fired).toBe(1)
    expect(spawned).toHaveLength(1)
    expect((await store.get(stuck[0]!.id))!.state).toBe("fired")
  })

  it("the pending guard serializes fire vs expire (no double)", async () => {
    const { clock, wakes, spawned } = harness()
    const { token } = await wakes.requestApproval({
      sessionId: "s1",
      workspaceId: WS,
      prompt: "?",
      expiresAt: clock.t + 1,
    })
    // resolve wins the pending guard first
    expect(await wakes.resolve(token, "yes", { userId: "p" })).toEqual({ ok: true })
    // now overdue, but already fired → runDue must not expire/refire it
    clock.t += 10
    expect((await wakes.runDue()).fired).toBe(0)
    expect(spawned).toHaveLength(1)
  })
})

describe("typed durations (ms strings)", () => {
  it("schedule({ in: '3d' }) fires exactly three days out", async () => {
    const { clock, wakes, store } = harness()
    const { wakeId } = await wakes.schedule({ sessionId: "s1", workspaceId: WS, in: "3d", intent: {} })
    expect((await store.get(wakeId))!.fireAt).toBe(clock.t + 3 * 86_400_000)
  })

  it("expiresIn works on watch and requestApproval, and absolute expiresAt wins over it", async () => {
    const { clock, wakes, store } = harness()
    const w = await wakes.watch({ sessionId: "s1", workspaceId: WS, eventKey: "e", intent: {}, expiresIn: "12h" })
    expect((await store.get(w.wakeId))!.expiresAt).toBe(clock.t + 12 * 3_600_000)

    const a = await wakes.requestApproval({ sessionId: "s1", workspaceId: WS, prompt: "?", expiresIn: "1d" })
    expect((await store.getByToken(a.token))!.expiresAt).toBe(clock.t + 86_400_000)

    const b = await wakes.watch({
      sessionId: "s1",
      workspaceId: WS,
      eventKey: "e2",
      intent: {},
      expiresAt: clock.t + 5,
      expiresIn: "12h",
    })
    expect((await store.get(b.wakeId))!.expiresAt).toBe(clock.t + 5)
  })

  it("requestApproval without any expiry is rejected", async () => {
    const { wakes } = harness()
    await expect(wakes.requestApproval({ sessionId: "s1", workspaceId: WS, prompt: "?" })).rejects.toThrow(
      /expiresAt.*expiresIn/,
    )
  })

  it("an unparseable duration is rejected at create time", async () => {
    const { wakes } = harness()
    await expect(
      wakes.schedule({ workspaceId: WS, in: "3 fortnights" as never, intent: {} }),
    ).rejects.toThrow(/invalid duration/)
  })
})

describe("idempotency + once", () => {
  it("schedule with the same idempotencyKey creates one wake", async () => {
    const { clock, wakes } = harness()
    const a = await wakes.schedule({ workspaceId: WS, at: clock.t + 1, intent: {}, idempotencyKey: "k1" })
    const b = await wakes.schedule({ workspaceId: WS, at: clock.t + 1, intent: {}, idempotencyKey: "k1" })
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

  it("once claims the receipt atomically: concurrent callers run fn once and share its result", async () => {
    const { wakes } = harness()
    let calls = 0
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const run = () =>
      wakes.once("s1", "open-pr:branch-x", async () => {
        calls++
        await gate // hold the claim so the loser has to wait on it
        return { pr: calls }
      })
    const first = run()
    await new Promise((r) => setTimeout(r, 25)) // first holds the claim
    const second = run() // must wait, never re-run fn
    await new Promise((r) => setTimeout(r, 25))
    releaseGate()
    const [a, b] = await Promise.all([first, second])
    expect(calls).toBe(1)
    expect(b).toEqual(a) // the loser reads back the winner's recorded result
    expect(await run()).toEqual(a)
    expect(calls).toBe(1)
  })

  it("once frees the key when the claim's lease lapses after a crashed effect", async () => {
    const { clock, wakes } = harness()
    await expect(
      wakes.once("s1", "open-pr:branch-x", async () => {
        throw new Error("effect died mid-run")
      }),
    ).rejects.toThrow("effect died mid-run")
    // The abandoned claim still holds the key until its lease lapses.
    clock.t += 30_000
    expect(await wakes.once("s1", "open-pr:branch-x", async () => "retried")).toBe("retried")
    expect(await wakes.once("s1", "open-pr:branch-x", async () => "ignored")).toBe("retried")
  })
})

describe("input validation", () => {
  it("rejects nonfinite fire and expiry times on every create path", async () => {
    const { clock, wakes } = harness()
    await expect(wakes.schedule({ workspaceId: WS, at: Number.NaN, intent: {} })).rejects.toThrow(/finite/)
    await expect(wakes.schedule({ workspaceId: WS, at: Number.POSITIVE_INFINITY, intent: {} })).rejects.toThrow(
      /finite/,
    )
    // An invalid Date's getTime() is NaN — caught at the same funnel.
    await expect(wakes.schedule({ workspaceId: WS, at: new Date("not a date"), intent: {} })).rejects.toThrow(
      /finite/,
    )
    await expect(
      wakes.watch({ workspaceId: WS, eventKey: "e", intent: {}, expiresAt: Number.NEGATIVE_INFINITY }),
    ).rejects.toThrow(/finite/)
    await expect(
      wakes.requestApproval({ workspaceId: WS, prompt: "?", expiresAt: Number.NaN }),
    ).rejects.toThrow(/finite/)

    // A cron parser that hands back garbage dies at the same funnel.
    const bad = createWakes({
      store: new SqliteWakeStore(),
      now: () => clock.t,
      authorize: () => true,
      computeNextRun: () => Number.NaN,
      spawnTurn: async () => {},
    })
    await expect(bad.schedule({ workspaceId: WS, cron: "* * * * *", intent: {} })).rejects.toThrow(/finite/)
  })

  it("createWakes requires an explicit authorize policy", () => {
    expect(() =>
      createWakes({ store: new SqliteWakeStore(), spawnTurn: async () => {} } as never),
    ).toThrow(/authorize/)
  })
})

describe("listForSession", () => {
  it("scopes rows to the session and never exposes the approval token", async () => {
    const { clock, wakes, store } = harness()
    const approval = await wakes.requestApproval({
      sessionId: "s1",
      workspaceId: WS,
      prompt: "?",
      expiresAt: clock.t + 1000,
    })
    await wakes.schedule({ sessionId: "s2", workspaceId: WS, at: clock.t + 1000, intent: {} })

    const s1 = await wakes.listForSession("s1")
    expect(s1).toHaveLength(1)
    expect(s1[0]!.triggerType).toBe("on_approval")
    expect(s1[0]!.token).toBeNull()
    // The stored row still holds the capability; only the list view redacts it.
    expect((await store.getByToken(approval.token))!.id).toBe(s1[0]!.id)

    // Another session's wakes are neither listed nor confirmable through it.
    const s2 = await wakes.listForSession("s2")
    expect(s2).toHaveLength(1)
    expect(s2[0]!.sessionId).toBe("s2")
    expect(await wakes.listForSession("nobody")).toHaveLength(0)
  })
})

describe("budgets", () => {
  it("rejects over-max-live, over-horizon, and over-depth", async () => {
    const { clock, wakes } = harness({ budgets: { maxLiveWakes: 2, maxHorizonMs: 10_000, maxDepth: 2 } })
    await wakes.schedule({ workspaceId: WS, at: clock.t + 1, intent: {} })
    await wakes.schedule({ workspaceId: WS, at: clock.t + 1, intent: {} })
    await expect(wakes.schedule({ workspaceId: WS, at: clock.t + 1, intent: {} })).rejects.toThrow(BudgetError)

    const fresh = harness({ budgets: { maxHorizonMs: 10_000, maxDepth: 2 } })
    await expect(
      fresh.wakes.schedule({ workspaceId: WS, at: fresh.clock.t + 999_999, intent: {} }),
    ).rejects.toThrow(/horizon/)
    await expect(
      fresh.wakes.schedule({ workspaceId: WS, at: fresh.clock.t + 1, intent: {}, depth: 3 }),
    ).rejects.toThrow(/depth/)
  })
})
