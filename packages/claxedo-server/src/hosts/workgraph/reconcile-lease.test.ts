/**
 * W4.4 acceptance: two concurrent `scheduled()` invocations run the reconcile
 * body ONCE, and a dead holder's lease expires so the next tick proceeds.
 *
 * ## Why this needs a lease at all
 *
 * `skipOverlappingReconcile`'s flag is a closure variable inside `worker.ts`'s
 * memoized `buildApp`, so it is per-isolate. Two `scheduled()` invocations
 * served by two isolates each see `running === false` and both enter a body
 * whose overlap once hung the Workers runtime (staging run 29514161976).
 *
 * ## How two isolates are simulated
 *
 * An isolate's guard identity IS its closure, so two independent
 * `skipOverlappingReconcile(...)` wrappers are two isolates by construction.
 * Both are fenced by the SAME fake lease store, which is what one Convex
 * deployment is across isolates. Same construction as
 * `rate-limit.shared-store.test.ts` (W3) and `http-idempotency.durable.test.ts`
 * (W4.2).
 *
 * ## Positive control
 *
 * Each cross-isolate test replays the identical sequence with the lease REMOVED
 * (bare `skipOverlappingReconcile`, i.e. pre-fix code) and asserts the body runs
 * TWICE. Without that, "ran once" could be a test whose two isolates were never
 * really separate.
 */

import { describe, expect, test, vi } from "vitest"
import {
  leaseFencedReconcile,
  skipOverlappingReconcile,
  WORKGRAPH_RECONCILE_LEASE,
  type CronLease,
} from "./reconcile-serialize"
import type { WorkGraphReconcileResult } from "../../routes/hosted/workgraph-admin"

const EMPTY: WorkGraphReconcileResult = { launched: [], results: [] }

/**
 * In-memory stand-in for `convex/cronLease.ts`: one row per lease name, shared
 * by every isolate holding a reference. Clock-driven so expiry is testable
 * without sleeping.
 */
function fakeLeaseStore(clock = { now: 1_000 }, leaseMs = 5 * 60_000) {
  const rows = new Map<string, { holder: string; fence: number; expiresAt: number }>()
  const lease: CronLease & { rows: typeof rows; clock: typeof clock } = {
    rows,
    clock,
    async acquire({ name, holder }) {
      const existing = rows.get(name)
      if (existing && existing.expiresAt > clock.now && existing.holder !== holder) {
        return { acquired: false }
      }
      const fence = (existing?.fence ?? 0) + 1
      rows.set(name, { holder, fence, expiresAt: clock.now + leaseMs })
      return { acquired: true, fence }
    },
    async release({ name, holder, fence }) {
      const existing = rows.get(name)
      // Fence-checked: a zombie's late release must not free the CURRENT
      // holder's claim.
      if (!existing || existing.holder !== holder || existing.fence !== fence) return
      rows.set(name, { ...existing, expiresAt: 0 })
    },
  }
  return lease
}

/**
 * One "isolate", composed in the same order as `worker.ts`: the free local guard
 * OUTSIDE the lease, so a same-isolate overlap never spends a Convex call and
 * only a trigger the local guard admits reaches the lease.
 */
function isolate(input: {
  reconcile: () => Promise<WorkGraphReconcileResult>
  lease?: CronLease
  holder: string
}) {
  if (!input.lease) return skipOverlappingReconcile(input.reconcile)
  return skipOverlappingReconcile(
    leaseFencedReconcile({ reconcile: input.reconcile, lease: input.lease, holder: input.holder }),
  )
}

describe("W4.4 fenced cron lease", () => {
  test("two concurrent scheduled() invocations run the reconcile body ONCE", async () => {
    const lease = fakeLeaseStore()
    const started = { count: 0 }
    const gate = Promise.withResolvers<void>()
    const body = vi.fn(async () => {
      started.count += 1
      await gate.promise
      return EMPTY
    })

    const isolateA = isolate({ reconcile: body, lease, holder: "isolate-a" })
    const isolateB = isolate({ reconcile: body, lease, holder: "isolate-b" })

    // Both cron invocations fire while the first is still inside the body —
    // the exact overlap that hung the runtime.
    const a = isolateA()
    await vi.waitFor(() => expect(started.count).toBe(1))
    const b = await isolateB()

    expect(body).toHaveBeenCalledTimes(1)
    // The refused invocation reports the SAME shape as a local skip, so cron
    // and the admin route need no new branch.
    expect(b).toEqual({ launched: [], results: [], skipped: true })

    gate.resolve()
    await a

    // POSITIVE CONTROL: identical sequence with no lease — pre-fix code. Both
    // isolates enter the body, which is the bug.
    const leakyGate = Promise.withResolvers<void>()
    const leakyStarted = { count: 0 }
    const leakyBody = vi.fn(async () => {
      leakyStarted.count += 1
      await leakyGate.promise
      return EMPTY
    })
    const bare = [
      isolate({ reconcile: leakyBody, holder: "isolate-a" }),
      isolate({ reconcile: leakyBody, holder: "isolate-b" }),
    ]
    const runs = bare.map((run) => run())
    await vi.waitFor(() => expect(leakyStarted.count).toBe(2))
    expect(leakyBody).toHaveBeenCalledTimes(2)
    leakyGate.resolve()
    await Promise.all(runs)
  })

  test("a dead holder's lease expires so the next tick proceeds", async () => {
    // The motivating incident is a HANG, so a lease that could not expire would
    // turn one stalled isolate into a reconciler that never runs again —
    // strictly worse than the overlap it prevents.
    const clock = { now: 1_000 }
    const lease = fakeLeaseStore(clock)

    // Isolate A claims the lease and hangs forever.
    const hung = vi.fn(() => new Promise<WorkGraphReconcileResult>(() => {}))
    void isolate({ reconcile: hung, lease, holder: "isolate-a" })()
    await vi.waitFor(() => expect(hung).toHaveBeenCalledTimes(1))

    // Before expiry, the next tick is correctly refused.
    const blocked = vi.fn(async () => EMPTY)
    await expect(isolate({ reconcile: blocked, lease, holder: "isolate-b" })())
      .resolves.toEqual({ launched: [], results: [], skipped: true })
    expect(blocked).not.toHaveBeenCalled()

    // After the TTL lapses, the next tick takes over and runs. No operator
    // action, no unwedge step.
    clock.now += 5 * 60_000 + 1
    const recovered = vi.fn(async () => EMPTY)
    await expect(isolate({ reconcile: recovered, lease, holder: "isolate-c" })()).resolves.toEqual(EMPTY)
    expect(recovered).toHaveBeenCalledTimes(1)
  })

  test("a completed run releases the lease so the next tick starts immediately", async () => {
    const lease = fakeLeaseStore()
    const body = vi.fn(async () => EMPTY)

    await isolate({ reconcile: body, lease, holder: "isolate-a" })()
    // Released, not merely expired: the next tick must not wait out the TTL.
    expect(lease.rows.get(WORKGRAPH_RECONCILE_LEASE)?.expiresAt).toBe(0)

    await isolate({ reconcile: body, lease, holder: "isolate-b" })()
    expect(body).toHaveBeenCalledTimes(2)
  })

  test("a failing run releases the lease and propagates the failure", async () => {
    // A reconcile that throws must not hold the lease for the whole TTL — and
    // the throw must still reach `scheduled`'s wrapper, which is the only place
    // a failed cron becomes visible.
    const lease = fakeLeaseStore()
    const failing = leaseFencedReconcile({
      reconcile: async () => {
        throw new Error("reconcile exploded")
      },
      lease,
      holder: "isolate-a",
    })
    await expect(failing()).rejects.toThrow("reconcile exploded")
    expect(lease.rows.get(WORKGRAPH_RECONCILE_LEASE)?.expiresAt).toBe(0)

    const next = vi.fn(async () => EMPTY)
    await expect(leaseFencedReconcile({ reconcile: next, lease, holder: "isolate-b" })()).resolves.toEqual(EMPTY)
    expect(next).toHaveBeenCalledTimes(1)
  })

  test("a zombie holder's release does not free the current holder's lease", async () => {
    // The fence is what makes this a FENCED lease rather than a mutual-exclusion
    // flag: a holder whose claim was taken over is identifiable, so its late
    // release cannot unlock the new holder's run.
    const clock = { now: 1_000 }
    const lease = fakeLeaseStore(clock)
    const zombieGate = Promise.withResolvers<void>()
    const zombie = leaseFencedReconcile({
      reconcile: async () => {
        await zombieGate.promise
        return EMPTY
      },
      lease,
      holder: "isolate-zombie",
    })
    const zombieRun = zombie()
    await vi.waitFor(() => expect(lease.rows.has(WORKGRAPH_RECONCILE_LEASE)).toBe(true))

    // Its lease lapses and a new holder takes over.
    clock.now += 5 * 60_000 + 1
    const takeover = await lease.acquire({ name: WORKGRAPH_RECONCILE_LEASE, holder: "isolate-live" })
    expect(takeover).toMatchObject({ acquired: true })

    // The zombie finally returns and releases. The live holder keeps its claim.
    zombieGate.resolve()
    await zombieRun
    const row = lease.rows.get(WORKGRAPH_RECONCILE_LEASE)
    expect(row?.holder).toBe("isolate-live")
    expect(row?.expiresAt).toBeGreaterThan(clock.now)

    // And a third isolate is still correctly refused.
    const blocked = vi.fn(async () => EMPTY)
    await expect(leaseFencedReconcile({ reconcile: blocked, lease, holder: "isolate-third" })())
      .resolves.toEqual({ launched: [], results: [], skipped: true })
    expect(blocked).not.toHaveBeenCalled()
  })

  test("a same-isolate overlap is rejected locally without spending a lease call", async () => {
    // The two layers are not redundant: the local flag is free and catches the
    // common case, the lease catches what the flag cannot see.
    const lease = fakeLeaseStore()
    const acquire = vi.spyOn(lease, "acquire")
    const gate = Promise.withResolvers<void>()
    const body = vi.fn(async () => {
      await gate.promise
      return EMPTY
    })
    // One isolate, so ONE local guard shared by both triggers (cron + admin).
    const fenced = isolate({ reconcile: body, lease, holder: "isolate-a" })

    const first = fenced()
    await vi.waitFor(() => expect(body).toHaveBeenCalledTimes(1))
    await expect(fenced()).resolves.toEqual({ launched: [], results: [], skipped: true })

    expect(body).toHaveBeenCalledTimes(1)
    // The second trigger never reached Convex: the local guard short-circuited
    // it. This is why the guard wraps the lease rather than the reverse — a
    // same-holder re-acquire would otherwise succeed as a renewal and spend a
    // round trip on every polled trigger.
    expect(acquire).toHaveBeenCalledTimes(1)

    gate.resolve()
    await first
  })
})
