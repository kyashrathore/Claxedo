import { describe, expect, test } from "vitest"
import { convexTest } from "convex-test"
import { internal } from "./_generated/api"
import schema from "./schema"
import crons from "./crons"
import { sweepStaleLeases } from "./sandboxLeases"

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob("./**/*.ts")

const stamped = <T extends Record<string, unknown>>(row: T) => ({ created_at: 1, updated_at: 1, ...row })

// D13 sandbox lease reaper — Convex-side sweep policy (ADR 016 §4 Decision 3).
//
// The sweep is the level-triggered truth-keeper for the lease table: dead
// in-flight acquires become `unavailable`, heartbeat-silent ready leases
// become `stopped` (keeping driver identity for resume), fresh leases are
// never touched, and re-running converges (idempotent). Driver-side destroys
// live in `sandboxManager.garbageCollect()` behind the CF Cron Trigger — this
// module must stay driver-credential-free.
//
// `sweepStaleLeases` is a `cronMutation` (internal) — convex-test has no cron
// scheduler, so every test below invokes it directly via `internal.*` rather
// than waiting on the 10-minute interval registered in `convex/crons.ts`
// (asserted separately, below, by reading the registration data directly).
//
// The previous version of this suite drove a hand-rolled index harness
// against a `Map`-backed double and reached past `cronMutation` into
// `_handler`, so it never exercised the real `by_status` index or the
// `internalMutationGeneric` visibility it depends on.
describe("Convex lease reaper sweep (D13)", () => {
  test("the sweep is an internal function: not callable by any client", () => {
    // cronMutation wraps internalMutationGeneric — only the Convex
    // scheduler/crons can invoke it. A public sweep would be an
    // unauthenticated mass-write endpoint.
    expect((sweepStaleLeases as { isInternal?: boolean }).isInternal).toBe(true)
  })

  const HOUR = 60 * 60 * 1_000
  const sweepArgs = {
    acquiring_stale_after_ms: 15 * 60 * 1_000,
    ready_heartbeat_stale_after_ms: 30 * 60 * 1_000,
  }

  async function seedLease(t: ReturnType<typeof convexTest>, overrides: Record<string, unknown> = {}) {
    return t.run(async (ctx) => ctx.db.insert("runtime_leases", stamped({
      workspace_id: "ws_1",
      home_region: "us-east",
      driver: "daytona",
      epoch: 1,
      status: "ready",
      retry_count: 0,
      created_at: 1_000,
      updated_at: 1_000,
      ...overrides,
    }) as never))
  }

  // W5: the sweep also settles a lease's billable interval when it closes a
  // heartbeat-silent lease, and reports how many it settled. These fixtures
  // carry no tenant, so `closed_intervals` stays 0 throughout — a metering
  // fact keyed on a fabricated org would be worse than none. The
  // tenant-carrying paths are covered in usage-metering.policy.test.ts.
  test("a dead in-flight acquire is marked unavailable and keeps its driver identity for reconciliation", async () => {
    const t = convexTest(schema, modules)
    const id = await seedLease(t, {
      status: "acquiring",
      epoch: 3,
      driver_resource_id: "res_1",
      sandbox_id: "sb_1",
      updated_at: 1_000,
    })

    await expect(t.mutation(internal.sandboxLeases.sweepStaleLeases, {
      ...sweepArgs,
      now: 1_000 + HOUR,
    })).resolves.toEqual({ scanned: 1, marked_unavailable: 1, marked_stopped: 0, closed_intervals: 0 })

    const row = await t.run(async (ctx) => ctx.db.get(id))
    expect(row).toMatchObject({
      status: "unavailable",
      epoch: 3,
      driver_resource_id: "res_1",
      sandbox_id: "sb_1",
      updated_at: 1_000 + HOUR,
    })
    expect(row!.last_error).toContain("reaper")
  })

  test("a fresh in-flight acquire is never touched", async () => {
    const t = convexTest(schema, modules)
    const id = await seedLease(t, { status: "acquiring", updated_at: 1_000 })
    const before = await t.run(async (ctx) => ctx.db.get(id))

    await expect(t.mutation(internal.sandboxLeases.sweepStaleLeases, {
      ...sweepArgs,
      now: 1_000 + 60_000, // one minute in: a legitimate cold start
    })).resolves.toEqual({ scanned: 1, marked_unavailable: 0, marked_stopped: 0, closed_intervals: 0 })

    await expect(t.run(async (ctx) => ctx.db.get(id))).resolves.toEqual(before)
  })

  test("a heartbeat-silent ready lease is marked stopped and keeps driver identity for resume", async () => {
    const t = convexTest(schema, modules)
    const id = await seedLease(t, {
      status: "ready",
      sandbox_id: "sb_1",
      host_id: "host_1",
      driver_resource_id: "res_1",
      runtime_url: "https://sb.test",
      last_heartbeat_at: 5_000,
      updated_at: 5_000,
    })

    await expect(t.mutation(internal.sandboxLeases.sweepStaleLeases, {
      ...sweepArgs,
      now: 5_000 + HOUR,
    })).resolves.toEqual({ scanned: 1, marked_unavailable: 0, marked_stopped: 1, closed_intervals: 0 })

    const row = await t.run(async (ctx) => ctx.db.get(id))
    expect(row).toMatchObject({
      status: "stopped",
      sandbox_id: "sb_1",
      host_id: "host_1",
      driver_resource_id: "res_1",
      runtime_url: "https://sb.test",
      epoch: 1,
    })
    expect(row!.last_error).toContain("reaper")
  })

  test("a ready lease with a recent heartbeat is never touched", async () => {
    const t = convexTest(schema, modules)
    const id = await seedLease(t, {
      status: "ready",
      last_heartbeat_at: 100_000,
      updated_at: 1_000,
    })
    const before = await t.run(async (ctx) => ctx.db.get(id))

    await expect(t.mutation(internal.sandboxLeases.sweepStaleLeases, {
      ...sweepArgs,
      now: 100_000 + 60_000,
    })).resolves.toEqual({ scanned: 1, marked_unavailable: 0, marked_stopped: 0, closed_intervals: 0 })

    await expect(t.run(async (ctx) => ctx.db.get(id))).resolves.toEqual(before)
  })

  test("a ready lease that never heartbeated falls back to updated_at for staleness", async () => {
    const t = convexTest(schema, modules)
    const id = await seedLease(t, { status: "ready", updated_at: 1_000 })

    await expect(t.mutation(internal.sandboxLeases.sweepStaleLeases, {
      ...sweepArgs,
      now: 1_000 + HOUR,
    })).resolves.toEqual({ scanned: 1, marked_unavailable: 0, marked_stopped: 1, closed_intervals: 0 })
    await expect(t.run(async (ctx) => ctx.db.get(id))).resolves.toMatchObject({ status: "stopped" })
  })

  test("terminal leases (stopped/unavailable/destroyed) are left alone", async () => {
    const t = convexTest(schema, modules)
    await seedLease(t, { workspace_id: "ws_1", status: "stopped", updated_at: 1_000 })
    await seedLease(t, { workspace_id: "ws_2", status: "unavailable", updated_at: 1_000 })
    await seedLease(t, { workspace_id: "ws_3", status: "destroyed", updated_at: 1_000 })
    const before = await t.run(async (ctx) => ctx.db.query("runtime_leases").collect())

    // `scanned: 0` with three seeded rows is the W5 conversion showing
    // through, and it is the point rather than a regression: the sweep reads
    // the `acquiring`/`ready` index ranges, so terminal leases are not merely
    // left alone — they never enter the transaction's read-set. That is what
    // stops the reaper's cost from growing with every workspace that ever ran.
    // `scanned` now means "live candidates examined", not "table size".
    await expect(t.mutation(internal.sandboxLeases.sweepStaleLeases, {
      ...sweepArgs,
      now: 1_000 + 10 * HOUR,
    })).resolves.toEqual({ scanned: 0, marked_unavailable: 0, marked_stopped: 0, closed_intervals: 0 })
    await expect(t.run(async (ctx) => ctx.db.query("runtime_leases").collect())).resolves.toEqual(before)
  })

  test("re-running the sweep is idempotent: the second pass changes nothing", async () => {
    const t = convexTest(schema, modules)
    await seedLease(t, { workspace_id: "ws_1", status: "acquiring", updated_at: 1_000, driver_resource_id: "res_1" })
    await seedLease(t, { workspace_id: "ws_2", status: "ready", last_heartbeat_at: 1_000, updated_at: 1_000, sandbox_id: "sb_2" })
    const now = 1_000 + HOUR

    await expect(t.mutation(internal.sandboxLeases.sweepStaleLeases, { ...sweepArgs, now }))
      .resolves.toEqual({ scanned: 2, marked_unavailable: 1, marked_stopped: 1, closed_intervals: 0 })
    const afterFirst = await t.run(async (ctx) => ctx.db.query("runtime_leases").collect())

    // The second pass reads ZERO candidates, not two: the first pass moved
    // both rows to terminal statuses, which removes them from the index
    // ranges the sweep queries. Post-W5 the convergence is structural — a
    // settled lease is not re-examined and rejected, it is not visible to the
    // sweep at all.
    await expect(t.mutation(internal.sandboxLeases.sweepStaleLeases, { ...sweepArgs, now: now + HOUR }))
      .resolves.toEqual({ scanned: 0, marked_unavailable: 0, marked_stopped: 0, closed_intervals: 0 })
    await expect(t.run(async (ctx) => ctx.db.query("runtime_leases").collect())).resolves.toEqual(afterFirst)
  })
})

describe("Convex cron registration (D13)", () => {
  test("the reaper sweep is registered on a 10-minute interval with the policy grace periods", () => {
    const jobs = (crons as unknown as { crons: Record<string, { name: string; args: unknown[]; schedule: Record<string, unknown> }> }).crons
    const job = jobs["sweep stale runtime leases"]
    expect(job).toBeDefined()
    expect(job!.name).toBe("sandboxLeases:sweepStaleLeases")
    expect(job!.schedule).toEqual({ type: "interval", minutes: 10 })
    expect(job!.args).toEqual([{
      acquiring_stale_after_ms: 15 * 60 * 1_000,
      ready_heartbeat_stale_after_ms: 30 * 60 * 1_000,
    }])
  })
})
