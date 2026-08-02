import { describe, it, expect } from "vitest"
import { getFunctionName } from "convex/server"
import { createWakes, type Wake } from "@claxedo/wakes"
import { ConvexWakeStore, type ConvexWakeExecutor } from "./convex-wake-store"

// The Convex half runs only in a real deployment (no in-repo Convex runtime),
// so these tests pin the two halves of the adapter contract we CAN verify
// here: (1) every port op maps to the right function name with
// service-token-guarded snake_case args, and (2) the whole engine runs
// against this adapter when the executor faithfully mirrors the semantics
// convex/wakes.ts implements (insert dedup, lane-aware claim, CAS guard).
// The real-deployment proof rides the staging smoke (plan U9).

const TOKEN = "svc-token"

function recordingExecutor() {
  const calls: Array<{ kind: "mutation" | "query"; name: string; args: Record<string, unknown> }> = []
  const record = (kind: "mutation" | "query") => async (fn: unknown, args: Record<string, unknown>) => {
    const name = getFunctionName(fn as never) // "wakes:claimDueWakes"
    calls.push({ kind, name, args })
    // list/claim/find ops must return arrays for the adapter's casts
    return /claim|find|list/i.test(name) ? [] : null
  }
  const executor: ConvexWakeExecutor = { mutation: record("mutation"), query: record("query") }
  return { calls, executor }
}

function lastCall(calls: Array<{ name: string; args: Record<string, unknown> }>) {
  return calls.at(-1)!
}

describe("ConvexWakeStore call mapping", () => {
  it("sends the service token and snake_case args on every operation", async () => {
    const { calls, executor } = recordingExecutor()
    const store = new ConvexWakeStore({ executor, serviceToken: TOKEN, now: () => 42 })

    await store.getByIdempotencyKey("ws1", "k1")
    expect(lastCall(calls).args).toMatchObject({ service_token: TOKEN, workspace_id: "ws1", key: "k1" })

    await store.countCreatedSince("ws1", 100)
    expect(lastCall(calls).args).toMatchObject({ service_token: TOKEN, workspace_id: "ws1", since: 100 })

    await store.putReceipt("r1", "{}")
    expect(lastCall(calls).args).toMatchObject({ service_token: TOKEN, key: "r1", result_json: "{}", now: 42 })
  })

  it("passes the tri-state serialKey through claimDue intact", async () => {
    const { calls, executor } = recordingExecutor()
    const store = new ConvexWakeStore({ executor, serviceToken: TOKEN })

    await store.claimDue(1000, 30_000, 10)
    expect("serial_key" in lastCall(calls).args).toBe(false) // undefined = all lanes → omitted

    await store.claimDue(1000, 30_000, 10, null)
    expect(lastCall(calls).args.serial_key).toBeNull() // null lane is explicit

    await store.claimDue(1000, 30_000, 10, "org:a")
    expect(lastCall(calls).args.serial_key).toBe("org:a")
  })

  it("cas forwards the guarded transition and patch", async () => {
    const { calls, executor } = recordingExecutor()
    const store = new ConvexWakeStore({ executor, serviceToken: TOKEN })
    await store.cas("wake_1", "pending", "firing", { resultJson: "{}", leaseUntil: 99 })
    const call = lastCall(calls)
    expect(call.name).toContain("casWake")
    expect(call.args).toMatchObject({
      id: "wake_1",
      from: "pending",
      to: "firing",
      patch: { resultJson: "{}", leaseUntil: 99 },
    })
  })
})

// A faithful in-memory mirror of convex/wakes.ts semantics, keyed by function
// path suffix. If convex/wakes.ts changes semantics, update BOTH.
function fakeConvexExecutor() {
  const rows: Wake[] = []
  const receipts = new Map<string, string>()
  const laneScope = (list: Wake[], serialKey: unknown) =>
    serialKey === undefined
      ? list
      : list.filter((w) => (serialKey === null ? w.serialKey === null : w.serialKey === serialKey))

  async function handle(fn: unknown, args: Record<string, unknown>): Promise<unknown> {
    const name = getFunctionName(fn as never)
    if (args.service_token !== TOKEN) throw new Error("service token required")
    if (name.endsWith("insertWake")) {
      const wake = args as unknown as Wake
      if (wake.idempotencyKey != null) {
        const existing = rows.find(
          (w) => w.workspaceId === wake.workspaceId && w.idempotencyKey === wake.idempotencyKey,
        )
        if (existing) return { inserted: false }
      }
      rows.push({ ...wake })
      return { inserted: true }
    }
    if (name.endsWith("getWakeByIdempotencyKey")) {
      return rows.find((w) => w.workspaceId === args.workspace_id && w.idempotencyKey === args.key) ?? null
    }
    if (name.endsWith("getWakeByToken")) return rows.find((w) => w.token === args.token) ?? null
    if (name.endsWith("getWake")) return rows.find((w) => w.id === args.id) ?? null
    if (name.endsWith("claimDueWakes")) {
      const now = args.now as number
      const due = laneScope(
        rows.filter((w) => w.triggerType === "at" && w.state === "pending" && w.fireAt != null && w.fireAt <= now),
        "serial_key" in args ? args.serial_key : undefined,
      ).sort((a, b) => a.fireAt! - b.fireAt!)
      const claimed: Wake[] = []
      const taken = new Set<string>()
      for (const wake of due) {
        if (claimed.length >= (args.limit as number)) break
        if (wake.serialKey !== null) {
          if (taken.has(wake.serialKey)) continue
          if (rows.some((w) => w.state === "firing" && w.serialKey === wake.serialKey)) continue
          taken.add(wake.serialKey)
        }
        wake.state = "firing"
        wake.leaseUntil = now + (args.lease_ms as number)
        wake.attempts += 1
        claimed.push({ ...wake })
      }
      return claimed
    }
    if (name.endsWith("casWake")) {
      const wake = rows.find((w) => w.id === args.id)
      if (!wake || wake.state !== args.from) return false
      wake.state = args.to as Wake["state"]
      for (const [key, value] of Object.entries((args.patch ?? {}) as Record<string, unknown>)) {
        if (["resultJson", "leaseUntil", "firedAt", "resolvedBy"].includes(key)) {
          ;(wake as unknown as Record<string, unknown>)[key] = value ?? null
        }
      }
      return true
    }
    if (name.endsWith("findPendingWakesByEventKey")) {
      return rows.filter((w) => w.eventKey === args.event_key && w.state === "pending").map((w) => ({ ...w }))
    }
    if (name.endsWith("findExpirableWakes")) {
      return rows
        .filter((w) => w.state === "pending" && w.expiresAt != null && w.expiresAt <= (args.now as number))
        .map((w) => ({ ...w }))
    }
    if (name.endsWith("findReclaimableWakes")) {
      return laneScope(
        rows.filter((w) => w.state === "firing" && w.leaseUntil != null && w.leaseUntil <= (args.now as number)),
        "serial_key" in args ? args.serial_key : undefined,
      ).map((w) => ({ ...w }))
    }
    if (name.endsWith("reclaimFiringWakes")) {
      const reclaimed = laneScope(
        rows.filter((w) => w.state === "firing" && w.leaseUntil != null && w.leaseUntil <= (args.now as number)),
        "serial_key" in args ? args.serial_key : undefined,
      )
      for (const wake of reclaimed) wake.leaseUntil = (args.now as number) + (args.lease_ms as number)
      return reclaimed.map((w) => ({ ...w }))
    }
    if (name.endsWith("listFiringWakes")) return rows.filter((w) => w.state === "firing").map((w) => ({ ...w }))
    if (name.endsWith("listWakesForSession")) {
      return rows.filter((w) => w.sessionId === args.session_id).map((w) => ({ ...w }))
    }
    if (name.endsWith("countLiveWakes")) {
      return rows.filter((w) => w.workspaceId === args.workspace_id && w.state === "pending").length
    }
    if (name.endsWith("countWakesCreatedSince")) {
      return rows.filter((w) => w.workspaceId === args.workspace_id && w.createdAt >= (args.since as number)).length
    }
    if (name.endsWith("getWakeReceipt")) return receipts.get(args.key as string) ?? null
    if (name.endsWith("putWakeReceipt")) {
      if (!receipts.has(args.key as string)) receipts.set(args.key as string, args.result_json as string)
      return null
    }
    if (name.endsWith("gcWakes")) {
      const before = args.before as number
      const keep = rows.filter(
        (w) => !(["fired", "expired", "cancelled"].includes(w.state) && w.createdAt < before),
      )
      const removed = rows.length - keep.length
      rows.length = 0
      rows.push(...keep)
      return removed
    }
    throw new Error(`unhandled fake convex function: ${name}`)
  }

  const executor: ConvexWakeExecutor = {
    mutation: (fn, args) => handle(fn, args),
    query: (fn, args) => handle(fn, args),
  }
  return { executor, rows }
}

describe("engine runs end-to-end against ConvexWakeStore", () => {
  function harness() {
    const clock = { t: 1_000_000 }
    const { executor, rows } = fakeConvexExecutor()
    const store = new ConvexWakeStore({ executor, serviceToken: TOKEN, now: () => clock.t })
    const settled: Wake[] = []
    const wakes = createWakes({
      store,
      now: () => clock.t,
      sinks: { workgraph_settle: (wake) => void settled.push(wake) },
    })
    return { clock, rows, settled, wakes, store }
  }

  it("schedules, lane-claims, and fires the settlement dirty-flag wake shape", async () => {
    const { clock, wakes, settled } = harness()
    await wakes.schedule({
      workspaceId: "wg:org:me",
      kind: "workgraph_settle",
      serialKey: "org:me",
      at: clock.t,
      intent: { tenant: "org:me" },
      idempotencyKey: "settle:org:me",
    })
    // burst: second create coalesces onto the same wake
    const second = await wakes.schedule({
      workspaceId: "wg:org:me",
      kind: "workgraph_settle",
      serialKey: "org:me",
      at: clock.t,
      intent: { tenant: "org:me" },
      idempotencyKey: "settle:org:me",
    })
    expect((await wakes.runDue("org:me")).fired).toBe(1)
    expect(settled).toHaveLength(1)
    expect(settled[0]!.serialKey).toBe("org:me")
    expect((await wakes.runDue("org:me")).fired).toBe(0) // coalesced, not duplicated
    expect(second.wakeId).toBe(settled[0]!.id)
  })

  it("same-lane wakes stay serialized through the Convex claim path", async () => {
    const { clock, wakes, settled } = harness()
    await wakes.schedule({ workspaceId: "ws", kind: "workgraph_settle", serialKey: "k", at: clock.t, intent: { n: 1 } })
    await wakes.schedule({ workspaceId: "ws", kind: "workgraph_settle", serialKey: "k", at: clock.t + 1, intent: { n: 2 } })
    clock.t += 5
    expect((await wakes.runDue("k")).fired).toBe(1)
    expect((await wakes.runDue("k")).fired).toBe(1)
    expect(settled.map((w) => JSON.parse(w.intentJson))).toEqual([{ n: 1 }, { n: 2 }])
  })

  it("crash-recovery works through the adapter: lapsed lease is reclaimed and re-fired", async () => {
    const clock = { t: 1_000_000 }
    const { executor } = fakeConvexExecutor()
    const store = new ConvexWakeStore({ executor, serviceToken: TOKEN, now: () => clock.t })
    let boom = true
    const settled: Wake[] = []
    const wakes = createWakes({
      store,
      now: () => clock.t,
      sinks: {
        workgraph_settle: (wake) => {
          if (boom) {
            boom = false
            throw new Error("crash")
          }
          settled.push(wake)
        },
      },
    })
    await wakes.schedule({ workspaceId: "ws", kind: "workgraph_settle", serialKey: "k", at: clock.t, intent: {} })
    await expect(wakes.runDue("k")).rejects.toThrow("crash")
    expect((await wakes.runDue("k")).fired).toBe(0) // lease still live: lane held
    clock.t += 60_000
    expect((await wakes.runDue("k")).fired).toBe(1)
    expect(settled).toHaveLength(1)
  })
})
