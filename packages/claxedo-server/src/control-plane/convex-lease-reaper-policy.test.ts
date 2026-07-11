import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { listNeedingDriverReconciliation, sweepStaleLeases } from "../../../../convex/sandboxLeases"
import crons from "../../../../convex/crons"

// D13 sandbox lease reaper — Convex-side sweep policy
// (launch plan 2026-07-11-012 §1 / ADR 016 §4 Decision 3).
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

function fakeDb(seed: Row[] = []) {
  const rows = new Map(seed.map((row) => [row._id, { ...row }]))
  return {
    rows,
    db: {
      query: vi.fn(() => ({
        collect: vi.fn(async () => [...rows.values()]),
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
    } as never)).resolves.toEqual({ scanned: 1, marked_unavailable: 1, marked_stopped: 0 })

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
    } as never)).resolves.toEqual({ scanned: 1, marked_unavailable: 0, marked_stopped: 0 })

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
    } as never)).resolves.toEqual({ scanned: 1, marked_unavailable: 0, marked_stopped: 1 })

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
    } as never)).resolves.toEqual({ scanned: 1, marked_unavailable: 0, marked_stopped: 0 })

    expect(rows.get("lease_1")).toEqual(before)
  })

  test("a ready lease that never heartbeated falls back to updated_at for staleness", async () => {
    const { db, rows } = fakeDb([leaseRow({ status: "ready", updated_at: 1_000 })])

    await expect(handler(sweepStaleLeases)({ db } as never, {
      ...sweepArgs,
      now: 1_000 + HOUR,
    } as never)).resolves.toEqual({ scanned: 1, marked_unavailable: 0, marked_stopped: 1 })
    expect(rows.get("lease_1")).toMatchObject({ status: "stopped" })
  })

  test("terminal leases (stopped/unavailable/destroyed) are left alone", async () => {
    const { db, rows } = fakeDb([
      leaseRow({ _id: "lease_1", workspace_id: "ws_1", status: "stopped", updated_at: 1_000 }),
      leaseRow({ _id: "lease_2", workspace_id: "ws_2", status: "unavailable", updated_at: 1_000 }),
      leaseRow({ _id: "lease_3", workspace_id: "ws_3", status: "destroyed", updated_at: 1_000 }),
    ])
    const before = new Map([...rows].map(([id, row]) => [id, { ...row }]))

    await expect(handler(sweepStaleLeases)({ db } as never, {
      ...sweepArgs,
      now: 1_000 + 10 * HOUR,
    } as never)).resolves.toEqual({ scanned: 3, marked_unavailable: 0, marked_stopped: 0 })
    expect(rows).toEqual(before)
  })

  test("re-running the sweep is idempotent: the second pass changes nothing", async () => {
    const { db, rows } = fakeDb([
      leaseRow({ _id: "lease_1", workspace_id: "ws_1", status: "acquiring", updated_at: 1_000, driver_resource_id: "res_1" }),
      leaseRow({ _id: "lease_2", workspace_id: "ws_2", status: "ready", last_heartbeat_at: 1_000, updated_at: 1_000, sandbox_id: "sb_2" }),
    ])
    const now = 1_000 + HOUR

    await expect(handler(sweepStaleLeases)({ db } as never, { ...sweepArgs, now } as never))
      .resolves.toEqual({ scanned: 2, marked_unavailable: 1, marked_stopped: 1 })
    const afterFirst = new Map([...rows].map(([id, row]) => [id, { ...row }]))

    await expect(handler(sweepStaleLeases)({ db } as never, { ...sweepArgs, now: now + HOUR } as never))
      .resolves.toEqual({ scanned: 2, marked_unavailable: 0, marked_stopped: 0 })
    expect(rows).toEqual(afterFirst)
  })
})

describe("Convex leases-needing-driver-reconciliation listing (D13)", () => {
  test("rejects a wrong service token and fails closed when the env secret is unset", async () => {
    const { db } = fakeDb([leaseRow({ status: "stopped", sandbox_id: "sb_1" })])

    await expect(handler(listNeedingDriverReconciliation)({ db } as never, { service_token: "wrong" } as never))
      .rejects.toThrow("Unauthenticated")
    delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
    await expect(handler(listNeedingDriverReconciliation)({ db } as never, { service_token: "" } as never))
      .rejects.toThrow("Unauthenticated")
  })

  test("lists exactly the non-live leases that still claim a driver resource", async () => {
    const { db } = fakeDb([
      // Serving/live: never candidates, even with driver identity.
      leaseRow({ _id: "lease_1", workspace_id: "ws_ready", status: "ready", sandbox_id: "sb_1", driver_resource_id: "res_1" }),
      leaseRow({ _id: "lease_2", workspace_id: "ws_acquiring", status: "acquiring", driver_resource_id: "res_2" }),
      // Non-live WITH driver identity: the money direction — must be listed.
      leaseRow({ _id: "lease_3", workspace_id: "ws_stopped", status: "stopped", sandbox_id: "sb_3" }),
      leaseRow({ _id: "lease_4", workspace_id: "ws_unavailable", status: "unavailable", driver_resource_id: "res_4" }),
      leaseRow({ _id: "lease_5", workspace_id: "ws_destroyed", status: "destroyed", sandbox_id: "sb_5", driver_resource_id: "res_5" }),
      // Non-live WITHOUT driver identity: nothing for the driver to reconcile.
      leaseRow({ _id: "lease_6", workspace_id: "ws_bare", status: "unavailable" }),
    ])

    const listed = await handler(listNeedingDriverReconciliation)({ db } as never, {
      service_token: "svc_secret",
    } as never) as Array<{ workspace_id: string }>

    expect(listed.map((lease) => lease.workspace_id).toSorted()).toEqual([
      "ws_destroyed",
      "ws_stopped",
      "ws_unavailable",
    ])
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
