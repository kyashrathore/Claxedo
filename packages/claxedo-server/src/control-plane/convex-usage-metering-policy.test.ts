/**
 * W5 metering — Convex policy and arithmetic.
 *
 * Two things are load-bearing here and neither is "the emit function was
 * called":
 *
 * 1. `active_ms` is a real measurement. Under a fake clock a synthetic lease
 *    held open for a known interval must report that interval back, and no
 *    close path may count the same interval twice.
 * 2. `user_activated` fires exactly once per user for all time — an error turn
 *    does not activate, the first ok turn does, and every later ok turn does
 *    not re-fire.
 *
 * Plus the security law these functions inherit: the Convex function IS the
 * boundary, so every one of them rejects a wrong or absent service token.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { acquire, recordTenant, release, sweepStaleLeases } from "../../../../convex/sandboxLeases"
import {
  leaseEventsForSandbox,
  llmUsageForSession,
  llmUsageTotals,
  pruneUsageFacts,
  recordLlmTurn,
  rollupSandboxUsageDaily,
  sandboxUsageDaily,
} from "../../../../convex/usageMetering"

const prevServiceToken = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
const SERVICE = { service_token: "svc_secret" }

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

type Row = Record<string, unknown> & { _id: string }

/**
 * Multi-table fake. The index name is ignored on purpose: these handlers are
 * exercised for their arithmetic and their write predicates, and pinning index
 * names here would make the test fail on a pure index rename.
 */
function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables = new Map<string, Map<string, Row>>()
  for (const [table, rows] of Object.entries(seed)) {
    tables.set(table, new Map(rows.map((row) => [row._id, { ...row }])))
  }
  const rowsOf = (table: string) => {
    if (!tables.has(table)) tables.set(table, new Map())
    return tables.get(table)!
  }
  let sequence = 0

  const matcher = () => {
    const checks: Array<(row: Row) => boolean> = []
    const builder = {
      eq: (field: string, value: unknown) => {
        checks.push((row) => row[field] === value)
        return builder
      },
      gte: (field: string, value: number) => {
        checks.push((row) => (row[field] as number) >= value)
        return builder
      },
      lte: (field: string, value: number) => {
        checks.push((row) => (row[field] as number) <= value)
        return builder
      },
      lt: (field: string, value: number) => {
        checks.push((row) => (row[field] as number) < value)
        return builder
      },
      gt: (field: string, value: number) => {
        checks.push((row) => (row[field] as number) > value)
        return builder
      },
    }
    return { builder, checks }
  }

  const selection = (table: string, checks: Array<(row: Row) => boolean>) => {
    const rows = () => [...rowsOf(table).values()].filter((row) => checks.every((check) => check(row)))
    return {
      first: async () => rows()[0] ?? null,
      unique: async () => rows()[0] ?? null,
      collect: async () => rows(),
    }
  }

  return {
    tables,
    rowsOf,
    db: {
      query: (table: string) => ({
        withIndex: (_name: string, build: (q: ReturnType<typeof matcher>["builder"]) => unknown) => {
          const { builder, checks } = matcher()
          build(builder)
          return selection(table, checks)
        },
        ...selection(table, []),
      }),
      insert: async (table: string, value: Record<string, unknown>) => {
        sequence += 1
        const id = `${table}_${sequence}`
        rowsOf(table).set(id, { _id: id, ...value })
        return id
      },
      patch: async (id: string, value: Record<string, unknown>) => {
        for (const rows of tables.values()) {
          const row = rows.get(id)
          if (row) {
            rows.set(id, { ...row, ...value })
            return
          }
        }
      },
      replace: async (id: string, value: Record<string, unknown>) => {
        for (const rows of tables.values()) {
          if (rows.has(id)) {
            rows.set(id, { _id: id, ...value })
            return
          }
        }
      },
      delete: async (id: string) => {
        for (const rows of tables.values()) if (rows.delete(id)) return
      },
    },
  }
}

function handler(fn: unknown) {
  return (fn as { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<any> })._handler
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

const TURN = {
  org_id: "org_1",
  user_id: "user_sub_1",
  session_id: "s_1",
  harness: "pi",
  provider_id: "anthropic",
  model_id: "claude-sonnet-5",
  input_tokens: 100,
  output_tokens: 20,
  reasoning_tokens: 5,
  cache_read_tokens: 7,
  cache_write_tokens: 3,
  turn_status: "ok" as const,
  latency_ms: 1_234,
}

// ---------------------------------------------------------------------------

describe("sandbox lease intervals measure real elapsed time", () => {
  // The DoD's fake clock: hold a lease open for a known N and require the
  // recorded duration back within ±5s. `now` is injected into both ends, so
  // "the fake clock" is the only clock involved.
  const TOLERANCE_MS = 5_000

  test.each([
    ["one minute", 60_000],
    ["ninety minutes", 90 * 60_000],
    ["twenty-six hours", 26 * 60 * 60_000],
  ])("a lease held open for %s reports active_ms within ±5s", async (_label, interval) => {
    const opened = 1_700_000_000_000
    const { db, rowsOf } = fakeDb()

    await handler(acquire)({ db } as never, {
      ...SERVICE,
      workspace_id: "ws_1",
      home_region: "us-east",
      driver: "daytona",
      stale_after_ms: 60_000,
      org_id: "org_1",
      user_id: "user_sub_1",
      now: opened,
    } as never)

    const released = await handler(release)({ db } as never, {
      ...SERVICE,
      workspace_id: "ws_1",
      now: opened + interval,
    } as never)

    expect(released.released).toBe(true)
    expect(released.usage.active_ms).toBeGreaterThanOrEqual(interval - TOLERANCE_MS)
    expect(released.usage.active_ms).toBeLessThanOrEqual(interval + TOLERANCE_MS)
    expect(released.usage).toMatchObject({
      org_id: "org_1",
      user_id: "user_sub_1",
      workspace_id: "ws_1",
      driver: "daytona",
      started_at: opened,
      ended_at: opened + interval,
      reason: "explicit_release",
    })
    expect([...rowsOf("sandbox_lease_events").values()]).toHaveLength(1)
  })

  test("the reaper closes a heartbeat-silent lease as idle, once", async () => {
    const opened = 5_000_000
    const { db, rowsOf } = fakeDb({
      runtime_leases: [leaseRow({
        org_id: "org_1",
        user_id: "user_sub_1",
        started_at: opened,
        last_heartbeat_at: opened,
      })],
    })

    const first = await handler(sweepStaleLeases)({ db } as never, {
      acquiring_stale_after_ms: 900_000,
      ready_heartbeat_stale_after_ms: 1_800_000,
      now: opened + 2_000_000,
    } as never)
    expect(first).toMatchObject({ marked_stopped: 1, closed_intervals: 1 })

    const fact = [...rowsOf("sandbox_lease_events").values()][0]
    expect(fact).toMatchObject({ reason: "idle_timeout", active_ms: 2_000_000, date: "1970-01-01" })

    // A reaper that re-runs over the same stopped lease must not invent
    // compute: the row now carries `ended_at`, so the close predicate is false.
    const second = await handler(sweepStaleLeases)({ db } as never, {
      acquiring_stale_after_ms: 900_000,
      ready_heartbeat_stale_after_ms: 1_800_000,
      now: opened + 9_000_000,
    } as never)
    expect(second.closed_intervals).toBe(0)
    expect([...rowsOf("sandbox_lease_events").values()]).toHaveLength(1)
  })

  test("re-acquiring a stopped lease opens a fresh interval instead of extending the old one", async () => {
    const { db, rowsOf } = fakeDb({
      runtime_leases: [leaseRow({
        status: "stopped",
        org_id: "org_1",
        user_id: "user_sub_1",
        started_at: 1_000,
        ended_at: 2_000,
      })],
    })

    await handler(acquire)({ db } as never, {
      ...SERVICE,
      workspace_id: "ws_1",
      home_region: "us-east",
      driver: "daytona",
      stale_after_ms: 60_000,
      now: 10_000,
    } as never)
    expect(rowsOf("runtime_leases").get("lease_1")).toMatchObject({ started_at: 10_000 })
    expect(rowsOf("runtime_leases").get("lease_1")!.ended_at).toBeUndefined()

    const released = await handler(release)({ db } as never, {
      ...SERVICE,
      workspace_id: "ws_1",
      now: 25_000,
    } as never)
    expect(released.usage.active_ms).toBe(15_000)
  })

  test("a lease with no tenant records no fact rather than a fabricated one", async () => {
    const { db, rowsOf } = fakeDb({
      runtime_leases: [leaseRow({ started_at: 1_000 })],
    })

    const released = await handler(release)({ db } as never, {
      ...SERVICE,
      workspace_id: "ws_1",
      now: 61_000,
    } as never)
    expect(released.released).toBe(true)
    expect(released.usage).toBeNull()
    expect(rowsOf("sandbox_lease_events").size).toBe(0)
  })

  test("recordTenant attributes an unattributed lease and never re-attributes one", async () => {
    const { db, rowsOf } = fakeDb({ runtime_leases: [leaseRow({ started_at: 1_000 })] })

    await expect(handler(recordTenant)({ db } as never, {
      ...SERVICE,
      workspace_id: "ws_1",
      org_id: "org_1",
      user_id: "user_sub_1",
    } as never)).resolves.toMatchObject({ stamped: true })
    expect(rowsOf("runtime_leases").get("lease_1")).toMatchObject({ org_id: "org_1", user_id: "user_sub_1" })

    await expect(handler(recordTenant)({ db } as never, {
      ...SERVICE,
      workspace_id: "ws_1",
      org_id: "org_attacker",
      user_id: "user_attacker",
    } as never)).resolves.toMatchObject({ stamped: false, reason: "already_attributed" })
    expect(rowsOf("runtime_leases").get("lease_1")).toMatchObject({ org_id: "org_1" })

    await expect(handler(recordTenant)({ db } as never, {
      ...SERVICE,
      workspace_id: "ws_absent",
      org_id: "org_1",
      user_id: "user_sub_1",
    } as never)).resolves.toMatchObject({ stamped: false, reason: "no_lease" })
  })
})

describe("user_activated is an idempotent check-and-set", () => {
  const userRow = () => ({
    _id: "users_seed",
    token_identifier: "tok_1",
    clerk_subject: "user_sub_1",
    created_at: 1,
    updated_at: 1,
  })

  test("an error turn then an ok turn fires exactly once; a third turn does not re-fire", async () => {
    const { db, rowsOf } = fakeDb({ users: [userRow()] })
    const run = (input: Record<string, unknown>) =>
      handler(recordLlmTurn)({ db } as never, { ...SERVICE, ...TURN, ...input } as never)

    const errored = await run({ turn_status: "error", now: 1_000 })
    expect(errored.activated).toBe(false)
    expect(rowsOf("users").get("users_seed")!.first_activated_at).toBeUndefined()

    const first = await run({ turn_status: "ok", now: 2_000 })
    expect(first.activated).toBe(true)
    expect(rowsOf("users").get("users_seed")!.first_activated_at).toBe(2_000)

    const third = await run({ turn_status: "ok", now: 3_000 })
    expect(third.activated).toBe(false)
    // The stamp is the first ok turn's moment for all time, not the latest.
    expect(rowsOf("users").get("users_seed")!.first_activated_at).toBe(2_000)

    // Every turn is still recorded as usage — activation is a separate question.
    expect(rowsOf("llm_usage_events").size).toBe(3)
  })

  test("an unmatched subject records usage and creates no user", async () => {
    const { db, rowsOf } = fakeDb()
    const result = await handler(recordLlmTurn)({ db } as never, { ...SERVICE, ...TURN, now: 9 } as never)
    expect(result.activated).toBe(false)
    expect(rowsOf("llm_usage_events").size).toBe(1)
    expect(rowsOf("users").size).toBe(0)
  })

  test("the recorded row carries the turn verbatim and no service token", async () => {
    const { db, rowsOf } = fakeDb()
    await handler(recordLlmTurn)({ db } as never, { ...SERVICE, ...TURN, now: 42 } as never)
    const row = [...rowsOf("llm_usage_events").values()][0]
    expect(row).toMatchObject({ ...TURN, created_at: 42 })
    expect(row).not.toHaveProperty("service_token")
    expect(row).not.toHaveProperty("now")
  })
})

describe("readers make every metering table reachable", () => {
  test("llmUsageForSession and llmUsageTotals answer the per-user question", async () => {
    const { db } = fakeDb()
    await handler(recordLlmTurn)({ db } as never, { ...SERVICE, ...TURN, now: 100 } as never)
    await handler(recordLlmTurn)({ db } as never, {
      ...SERVICE,
      ...TURN,
      user_id: "user_sub_2",
      session_id: "s_2",
      turn_status: "error",
      now: 200,
    } as never)

    await expect(handler(llmUsageForSession)({ db } as never, { ...SERVICE, session_id: "s_1" } as never))
      .resolves.toHaveLength(1)

    const totals = await handler(llmUsageTotals)({ db } as never, { ...SERVICE, org_id: "org_1" } as never)
    expect(totals).toMatchObject({
      turn_count: 2,
      user_count: 2,
      input_tokens: 200,
      output_tokens: 40,
      reasoning_tokens: 10,
      error_turn_count: 1,
    })
    expect(totals.billable_tokens_per_user).toBe(125)
  })

  test("leaseEventsForSandbox surfaces the fact a staging check queries by sandbox_id", async () => {
    const { db } = fakeDb({
      runtime_leases: [leaseRow({
        org_id: "org_1",
        user_id: "user_sub_1",
        sandbox_id: "sbx_9",
        started_at: 1_000,
      })],
    })
    await handler(release)({ db } as never, { ...SERVICE, workspace_id: "ws_1", now: 31_000 } as never)

    await expect(handler(leaseEventsForSandbox)({ db } as never, { ...SERVICE, sandbox_id: "sbx_9" } as never))
      .resolves.toMatchObject([{ sandbox_id: "sbx_9", active_ms: 30_000 }])
  })
})

describe("the rollup and retention crons keep the answer bounded and honest", () => {
  const fact = (input: Partial<Row> = {}): Row => ({
    _id: "fact_seed",
    org_id: "org_1",
    user_id: "user_sub_1",
    workspace_id: "ws_1",
    sandbox_id: "sbx_1",
    driver: "daytona",
    started_at: 0,
    ended_at: 30_000,
    active_ms: 30_000,
    reason: "explicit_release",
    date: "2026-07-28",
    created_at: 30_000,
    ...input,
  })

  test("facts fold into daily buckets in seconds and are consumed exactly once", async () => {
    const { db, rowsOf } = fakeDb({
      sandbox_lease_events: [
        fact(),
        fact({ _id: "fact_seed_2", active_ms: 90_000 }),
        fact({ _id: "fact_seed_3", user_id: "user_sub_2", active_ms: 10_000 }),
      ],
    })

    const first = await handler(rollupSandboxUsageDaily)({ db } as never, { now: 99 } as never)
    expect(first).toMatchObject({ rolled_up: 3, buckets_created: 2 })

    const buckets = [...rowsOf("sandbox_usage_daily").values()]
    expect(buckets.find((row) => row.user_id === "user_sub_1")).toMatchObject({
      total_active_seconds: 120,
      lease_count: 2,
      date: "2026-07-28",
      driver: "daytona",
    })

    // Re-running is the whole point of a level-triggered cron: a second pass
    // over already-consumed facts must add nothing.
    const second = await handler(rollupSandboxUsageDaily)({ db } as never, { now: 200 } as never)
    expect(second).toMatchObject({ rolled_up: 0, buckets_created: 0 })
    expect(rowsOf("sandbox_usage_daily").size).toBe(2)

    const daily = await handler(sandboxUsageDaily)({ db } as never, { ...SERVICE, org_id: "org_1" } as never)
    expect(daily).toMatchObject({ total_active_seconds: 130, lease_count: 3, user_count: 2 })
    expect(daily.active_seconds_per_user).toBe(65)
  })

  test("retention prunes aged facts, keeps rollups, and never drops an uncounted fact", async () => {
    const now = 400 * 24 * 60 * 60 * 1000 + 1_000_000
    const { db, rowsOf } = fakeDb({
      sandbox_lease_events: [
        fact({ _id: "aged_counted", created_at: 1_000, rolled_up_at: 2_000 }),
        fact({ _id: "aged_uncounted", created_at: 1_000 }),
        fact({ _id: "fresh", created_at: now - 1_000, rolled_up_at: now }),
      ],
      sandbox_usage_daily: [{
        _id: "bucket_1",
        org_id: "org_1",
        user_id: "user_sub_1",
        date: "2026-07-28",
        driver: "daytona",
        total_active_seconds: 120,
        lease_count: 2,
        created_at: 1,
        updated_at: 1,
      }],
      llm_usage_events: [
        { _id: "turn_aged", ...TURN, created_at: 1_000 },
        { _id: "turn_fresh", ...TURN, created_at: now - 1_000 },
      ],
    })

    const result = await handler(pruneUsageFacts)({ db } as never, {
      retain_ms: 400 * 24 * 60 * 60 * 1000,
      now,
    } as never)
    expect(result).toMatchObject({ lease_events_deleted: 1, llm_usage_events_deleted: 1 })

    expect(rowsOf("sandbox_lease_events").has("aged_counted")).toBe(false)
    // Aged but never rolled up: pruning it would erase compute the daily table
    // has not yet counted.
    expect(rowsOf("sandbox_lease_events").has("aged_uncounted")).toBe(true)
    expect(rowsOf("sandbox_lease_events").has("fresh")).toBe(true)
    expect(rowsOf("llm_usage_events").has("turn_fresh")).toBe(true)
    // The rollup is the long-range answer and survives the prune.
    expect(rowsOf("sandbox_usage_daily").size).toBe(1)
  })
})

describe("the Convex function is the boundary", () => {
  test("every metering function rejects a wrong service token", async () => {
    const { db } = fakeDb({ runtime_leases: [leaseRow({ started_at: 1 })] })
    const wrong = { service_token: "wrong" }

    await expect(handler(recordLlmTurn)({ db } as never, { ...wrong, ...TURN } as never))
      .rejects.toThrow("Unauthenticated")
    await expect(handler(llmUsageForSession)({ db } as never, { ...wrong, session_id: "s_1" } as never))
      .rejects.toThrow("Unauthenticated")
    await expect(handler(llmUsageTotals)({ db } as never, wrong as never)).rejects.toThrow("Unauthenticated")
    await expect(handler(leaseEventsForSandbox)({ db } as never, { ...wrong, sandbox_id: "sbx_1" } as never))
      .rejects.toThrow("Unauthenticated")
    await expect(handler(sandboxUsageDaily)({ db } as never, wrong as never)).rejects.toThrow("Unauthenticated")
    await expect(handler(recordTenant)({ db } as never, {
      ...wrong,
      workspace_id: "ws_1",
      org_id: "org_x",
      user_id: "user_x",
    } as never)).rejects.toThrow("Unauthenticated")
  })

  test("an unset service-token secret fails closed, even for a matching empty token", async () => {
    delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
    const { db, rowsOf } = fakeDb()

    await expect(handler(recordLlmTurn)({ db } as never, { service_token: "", ...TURN } as never))
      .rejects.toThrow("Unauthenticated")
    await expect(handler(recordLlmTurn)({ db } as never, { service_token: "svc_secret", ...TURN } as never))
      .rejects.toThrow("Unauthenticated")
    expect(rowsOf("llm_usage_events").size).toBe(0)
  })

  test("the cron handlers are internal: not callable by any client, so they take no token", () => {
    for (const fn of [rollupSandboxUsageDaily, pruneUsageFacts]) {
      expect((fn as { isInternal?: boolean }).isInternal).toBe(true)
    }
    // The service-authed functions are NOT internal — they are called by the
    // control plane over HTTP with the shared secret.
    for (const fn of [recordLlmTurn, llmUsageTotals, sandboxUsageDaily, recordTenant]) {
      expect((fn as { isInternal?: boolean }).isInternal).toBeFalsy()
    }
  })

  test("every client-visible metering function demands the service token in its validator", async () => {
    // The deployment URL ships inside the web and desktop bundles, so anything
    // with public VISIBILITY is callable by anyone who opens devtools. The
    // service builders are public-visibility by construction and gate on the
    // shared secret instead — which only holds if the token is actually part of
    // the declared argument validator, not merely read by the handler.
    const exported = (fn: unknown) =>
      Object.keys(JSON.parse((fn as { exportArgs: () => string }).exportArgs()).value ?? {})

    for (const fn of [
      recordLlmTurn,
      recordTenant,
      llmUsageForSession,
      llmUsageTotals,
      leaseEventsForSandbox,
      sandboxUsageDaily,
    ]) {
      expect((fn as { isPublic?: boolean }).isPublic).toBe(true)
      expect(exported(fn)).toContain("service_token")
    }
    // The crons are the stronger stance: internal visibility, no token needed
    // because no client can reach them at all.
    for (const fn of [rollupSandboxUsageDaily, pruneUsageFacts]) {
      expect((fn as { isPublic?: boolean }).isPublic).toBeFalsy()
      expect(exported(fn)).not.toContain("service_token")
    }
  })
})

// Keep `vi` referenced for the shared lint posture of this directory's suites.
void vi
