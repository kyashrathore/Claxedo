import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { sweepStaleLeases } from "../../../../../convex/sandboxLeases"
import crons from "../../../../../convex/crons"
import { indexRangeBuilder, orderByIndex } from "../../test-helpers/convex-index-harness"

// D13 sandbox lease reaper — Convex-side sweep policy
// (ADR 016 §4 Decision 3).
//
// The sweep is the level-triggered truth-keeper for the lease table: dead
// in-flight acquires become `unavailable`, heartbeat-silent ready leases
// become `stopped` (keeping driver identity for resume), fresh leases are
// never touched, and re-running converges (idempotent). Driver-side destroys
// live in `sandboxManager.garbageCollect()` behind the CF Cron Trigger — this
// module must stay driver-credential-free.

type Row = Record<string, unknown> & { _id: string; workspace_id: string; epoch: number; status: string; updated_at: number; retry_count: number }

const prevServiceToken = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN

beforeEach(() => {
  process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "svc_secret"
})

afterEach(() => {
  if (prevServiceToken === undefined) {
    delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
    return
  }
  process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = prevServiceToken
})

// W5: the reaper now reads its candidates through `by_status` index ranges
// instead of scanning `runtime_leases`, so this double resolves index names
// against the real convex/schema.ts (see `convex-index-harness.ts`). A wrong
// index name or an out-of-order comparison throws here rather than silently
// behaving like the old unfiltered scan — which is what makes these tests
// evidence that the conversion preserved the sweep's behavior.
function fakeDb(seed: Row[] = []) {
  const rows = new Map(seed.map((row) => [row._id, { ...row }]))
  return {
    rows,
    db: {
      query: vi.fn((table: string) => ({
        withIndex: vi.fn((name: string, build: (q: unknown) => unknown) => {
          const { builder, checks } = indexRangeBuilder(table, name)
          build(builder)
          const matching = () => orderByIndex(
            [...rows.values()].filter((row) => checks.every((check) => check(row))),
            table,
            name,
          )
          return {
            collect: vi.fn(async () => matching()),
            take: vi.fn(async (limit: number) => matching().slice(0, limit)),
            first: vi.fn(async () => matching()[0] ?? null),
          }
        }),
        collect: vi.fn(async () => [...rows.values()]),
        take: vi.fn(async (limit: number) => [...rows.values()].slice(0, limit)),
      })),
      replace: vi.fn(async (id, value) => {
        rows.set(id, { _id: id, ...value } as Row)
      }),
      delete: vi.fn(async (id) => {
        rows.delete(id)
      }),
    },
  }
}

function handler(fn: unknown) {
  return (fn as { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown> })._handler
}

function leaseRow(input: Partial<Row> = {}): Row {
  return {
    _id: "lease_1",
    workspace_id: "ws_1",
    home_region: "us-east",
    driver: "daytona",
    epoch: 1,
    status: "ready",
    retry_count: 0,
    created_at: 1_000,
    updated_at: 1_000,
    ...input,
  }
}

const HOUR = 60 * 60 * 1_000
const sweepArgs = {
  acquiring_stale_after_ms: 15 * 60 * 1_000,
  ready_heartbeat_stale_after_ms: 30 * 60 * 1_000,
}

// W5: the sweep also settles a lease's billable interval when it closes a
// heartbeat-silent lease, and reports how many it settled. These fixtures carry
// no tenant, so `closed_intervals` stays 0 throughout — a metering fact keyed on
// a fabricated org would be worse than none. The tenant-carrying paths are
// covered in convex-usage-metering-policy.test.ts.
describe("Convex lease reaper sweep (D13)", () => {
  test("the sweep is an internal function: not callable by any client", () => {
    // cronMutation wraps internalMutationGeneric — only the Convex
    // scheduler/crons can invoke it. A public sweep would be an unauthenticated
    // mass-write endpoint.
    expect((sweepStaleLeases as { isInternal?: boolean }).isInternal).toBe(true)
  })

  test("a dead in-flight acquire is marked unavailable and keeps its driver identity for reconciliation", async () => {
    const { db, rows } = fakeDb([leaseRow({
      status: "acquiring",
      epoch: 3,
      driver_resource_id: "res_1",
      sandbox_id: "sb_1",
      updated_at: 1_000,
    })])

    await expect(handler(sweepStaleLeases)({ db } as never, {
      ...sweepArgs,
      now: 1_000 + HOUR,
    } as never)).resolves.toEqual({ scanned: 1, marked_unavailable: 1, marked_stopped: 0, closed_intervals: 0 })

    expect(rows.get("lease_1")).toMatchObject({
      status: "unavailable",
      epoch: 3,
      driver_resource_id: "res_1",
      sandbox_id: "sb_1",
      updated_at: 1_000 + HOUR,
    })
    expect(rows.get("lease_1")!.last_error).toContain("reaper")
  })

  test("a fresh in-flight acquire is never touched", async () => {
    const { db, rows } = fakeDb([leaseRow({ status: "acquiring", updated_at: 1_000 })])
    const before = { ...rows.get("lease_1")! }

    await expect(handler(sweepStaleLeases)({ db } as never, {
      ...sweepArgs,
      now: 1_000 + 60_000, // one minute in: a legitimate cold start
    } as never)).resolves.toEqual({ scanned: 1, marked_unavailable: 0, marked_stopped: 0, closed_intervals: 0 })

    expect(rows.get("lease_1")).toEqual(before)
  })

  test("a heartbeat-silent ready lease is marked stopped and keeps driver identity for resume", async () => {
    const { db, rows } = fakeDb([leaseRow({
      status: "ready",
      sandbox_id: "sb_1",
      host_id: "host_1",
      driver_resource_id: "res_1",
      runtime_url: "https://sb.test",
      last_heartbeat_at: 5_000,
      updated_at: 5_000,
    })])

    await expect(handler(sweepStaleLeases)({ db } as never, {
      ...sweepArgs,
      now: 5_000 + HOUR,
    } as never)).resolves.toEqual({ scanned: 1, marked_unavailable: 0, marked_stopped: 1, closed_intervals: 0 })

    expect(rows.get("lease_1")).toMatchObject({
      status: "stopped",
      sandbox_id: "sb_1",
      host_id: "host_1",
      driver_resource_id: "res_1",
      runtime_url: "https://sb.test",
      epoch: 1,
    })
    expect(rows.get("lease_1")!.last_error).toContain("reaper")
  })

  test("a ready lease with a recent heartbeat is never touched", async () => {
    const { db, rows } = fakeDb([leaseRow({
      status: "ready",
      last_heartbeat_at: 100_000,
      updated_at: 1_000,
    })])
    const before = { ...rows.get("lease_1")! }

    await expect(handler(sweepStaleLeases)({ db } as never, {
      ...sweepArgs,
      now: 100_000 + 60_000,
    } as never)).resolves.toEqual({ scanned: 1, marked_unavailable: 0, marked_stopped: 0, closed_intervals: 0 })

    expect(rows.get("lease_1")).toEqual(before)
  })

  test("a ready lease that never heartbeated falls back to updated_at for staleness", async () => {
    const { db, rows } = fakeDb([leaseRow({ status: "ready", updated_at: 1_000 })])

    await expect(handler(sweepStaleLeases)({ db } as never, {
      ...sweepArgs,
      now: 1_000 + HOUR,
    } as never)).resolves.toEqual({ scanned: 1, marked_unavailable: 0, marked_stopped: 1, closed_intervals: 0 })
    expect(rows.get("lease_1")).toMatchObject({ status: "stopped" })
  })

  test("terminal leases (stopped/unavailable/destroyed) are left alone", async () => {
    const { db, rows } = fakeDb([
      leaseRow({ _id: "lease_1", workspace_id: "ws_1", status: "stopped", updated_at: 1_000 }),
      leaseRow({ _id: "lease_2", workspace_id: "ws_2", status: "unavailable", updated_at: 1_000 }),
      leaseRow({ _id: "lease_3", workspace_id: "ws_3", status: "destroyed", updated_at: 1_000 }),
    ])
    const before = new Map([...rows].map(([id, row]) => [id, { ...row }]))

    // `scanned: 0` with three seeded rows is the W5 conversion showing through,
    // and it is the point rather than a regression: the sweep reads the
    // `acquiring`/`ready` index ranges, so terminal leases are not merely left
    // alone — they never enter the transaction's read-set. That is what stops
    // the reaper's cost from growing with every workspace that ever ran.
    // `scanned` now means "live candidates examined", not "table size".
    await expect(handler(sweepStaleLeases)({ db } as never, {
      ...sweepArgs,
      now: 1_000 + 10 * HOUR,
    } as never)).resolves.toEqual({ scanned: 0, marked_unavailable: 0, marked_stopped: 0, closed_intervals: 0 })
    expect(rows).toEqual(before)
  })

  test("re-running the sweep is idempotent: the second pass changes nothing", async () => {
    const { db, rows } = fakeDb([
      leaseRow({ _id: "lease_1", workspace_id: "ws_1", status: "acquiring", updated_at: 1_000, driver_resource_id: "res_1" }),
      leaseRow({ _id: "lease_2", workspace_id: "ws_2", status: "ready", last_heartbeat_at: 1_000, updated_at: 1_000, sandbox_id: "sb_2" }),
    ])
    const now = 1_000 + HOUR

    await expect(handler(sweepStaleLeases)({ db } as never, { ...sweepArgs, now } as never))
      .resolves.toEqual({ scanned: 2, marked_unavailable: 1, marked_stopped: 1, closed_intervals: 0 })
    const afterFirst = new Map([...rows].map(([id, row]) => [id, { ...row }]))

    // The second pass reads ZERO candidates, not two: the first pass moved both
    // rows to terminal statuses, which removes them from the index ranges the
    // sweep queries. Post-W5 the convergence is structural — a settled lease is
    // not re-examined and rejected, it is not visible to the sweep at all.
    await expect(handler(sweepStaleLeases)({ db } as never, { ...sweepArgs, now: now + HOUR } as never))
      .resolves.toEqual({ scanned: 0, marked_unavailable: 0, marked_stopped: 0, closed_intervals: 0 })
    expect(rows).toEqual(afterFirst)
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
