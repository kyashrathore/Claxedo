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
 *
 * The previous version of this suite drove a hand-rolled multi-table `Map`
 * double and reached past `serviceMutation`/`serviceQuery`/`cronMutation`
 * into `_handler`, so it never exercised `requireControlPlaneService`, the
 * real indexes, or the `internalMutationGeneric` visibility the crons depend
 * on.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { convexTest } from "convex-test"
import { api, internal } from "./_generated/api"
import schema from "./schema"
import { recordTenant } from "./sandboxLeases"
import {
  llmUsageForSession,
  llmUsageTotals,
  ingestTurnUsageBatch,
  usageDashboard,
  usageBreakdown,
  leaseEventsForSandbox,
  migrateLegacyLlmUsageRow,
  pruneUsageFacts,
  recordLlmTurn,
  rollupSandboxUsageDaily,
  sandboxUsageDaily,
} from "./usageMetering"
import { createConvexUsageLedger } from "../packages/claxedo-server/src/authority/adapters/convex/usage-ledger"
import { createUsageOutboxSync } from "../packages/claxedo-local-server/src/usage/outbox-sync"
import type { TurnUsageRevision } from "../packages/claxedo-server-core/src/usage/contracts"

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob("./**/*.ts")

const stamped = <T extends Record<string, unknown>>(row: T) => ({ created_at: 1_000, updated_at: 1_000, ...row })

beforeEach(() => {
  vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", "svc_secret")
})

afterEach(() => vi.unstubAllEnvs())

const SERVICE = { service_token: "svc_secret" }

async function seedLease(t: ReturnType<typeof convexTest>, overrides: Record<string, unknown> = {}) {
  return t.run(async (ctx) => ctx.db.insert("runtime_leases", stamped({
    workspace_id: "ws_1",
    home_region: "us-east",
    driver: "daytona",
    epoch: 1,
    status: "ready",
    retry_count: 0,
    ...overrides,
  }) as never))
}

const TURN = {
  org_id: "org_1",
  user_id: "user_sub_1",
  message_id: "msg_1",
  session_id: "s_1",
  stream_id: "stream_1",
  run_id: "run_1",
  work_item_id: "item_1",
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

const REVISION = {
  host_id: "host_1",
  session_ref: "workspace:ws_1:session:s_1",
  session_id: "s_1",
  message_id: "msg_1",
  revision: 1,
  observed_at: Date.UTC(2026, 6, 10),
  settlement: "provisional" as const,
  status: "running" as const,
  location: "local" as const,
  harness: "claude-sdk",
  provider_id: "anthropic",
  model_id: "claude-sonnet-5",
  workspace_id: "ws_1",
  input_tokens: 100,
  output_tokens: 20,
  reasoning_tokens: null,
  cache_read_tokens: 7,
  cache_write_tokens: null,
  quality: {
    source: "provider" as const,
    observation_kind: "cumulative" as const,
    known_categories: ["input", "output", "cache_read"] as const,
  },
}

function pipelineRevision(input: {
  hostId: string
  messageId: string
  observedAt: number
  status?: TurnUsageRevision["status"]
  settlement?: TurnUsageRevision["settlement"]
}): TurnUsageRevision {
  return {
    hostId: input.hostId,
    sessionRef: `workspace:ws_pipeline:session:${input.hostId}`,
    sessionId: input.hostId,
    messageId: input.messageId,
    revision: 1,
    observedAt: input.observedAt,
    completedAt: input.observedAt + 1,
    settlement: input.settlement ?? "final",
    status: input.status ?? "completed",
    location: input.hostId === "host-central" ? "central" : "local",
    harness: "pi",
    providerId: "anthropic",
    modelId: "claude-sonnet-5",
    workspaceId: "ws_pipeline",
    tokens: { input: 10, output: 2, reasoning: null, cache: { read: 1, write: null } },
    quality: { source: "provider", knownCategories: ["input", "output", "cache_read"] },
  }
}

describe("revisioned turn usage ingest", () => {
  test("runs signed outbox delivery through the real Convex adapter and preserves cross-machine, tenant, privacy, and retention boundaries", async () => {
    const t = convexTest(schema, modules)
    const captured: unknown[] = []
    const testConvex = t as unknown as {
      mutation: (fn: unknown, args: Record<string, unknown>) => Promise<unknown>
      query: (fn: unknown, args: Record<string, unknown>) => Promise<unknown>
    }
    const executor = {
      mutation: async (fn: unknown, args: Record<string, unknown>) => {
        captured.push(args)
        return await testConvex.mutation(fn, args)
      },
      query: async (fn: unknown, args: Record<string, unknown>) => {
        captured.push(args)
        return await testConvex.query(fn, args)
      },
    }
    const central = createConvexUsageLedger({ serviceToken: "svc_secret", executor })
    const observedAt = Date.UTC(2026, 7, 8, 12)
    let pending = [
      pipelineRevision({ hostId: "host-a", messageId: "local-complete", observedAt }),
      pipelineRevision({ hostId: "host-central", messageId: "central-error", observedAt: observedAt + 10, status: "error" }),
    ]
    const local = {
      pendingOutbox: async () => pending,
      claimPending: async () => pending,
      markDelivered: async (fact: TurnUsageRevision) => {
        pending = pending.filter((row) => !(row.hostId === fact.hostId && row.messageId === fact.messageId && row.revision === fact.revision))
      },
      markConflict: async () => { throw new Error("unexpected conflict") },
    }
    const sync = createUsageOutboxSync({ local: local as never, central })

    await expect(sync.clearIdentity()).resolves.toMatchObject({ attempted: 0, delivered: 0, pending: 2 })
    await expect(sync.flush({ org_id: "org-pipeline", user_id: "user-pipeline" }))
      .resolves.toMatchObject({ attempted: 2, delivered: 2, pending: 0 })

    const machineB = await central.usageDashboard?.({
      org_id: "org-pipeline", user_id: "user-pipeline",
      since: observedAt - 1, until: observedAt + 100, timeZone: "UTC", dimension: "harness",
    }) as any
    expect(machineB.totals).toMatchObject({ turn_count: 2, input_tokens: 20, output_tokens: 4, error_turn_count: 1 })
    expect(machineB.breakdown).toEqual([expect.objectContaining({ value: "pi", turn_count: 2 })])

    const otherTenant = await central.usageDashboard?.({
      org_id: "org-other", user_id: "user-pipeline",
      since: observedAt - 1, until: observedAt + 100, timeZone: "UTC",
    }) as any
    expect(otherTenant.totals.turn_count).toBe(0)
    await expect(createConvexUsageLedger({ serviceToken: "wrong", executor }).usageDashboard?.({
      org_id: "org-pipeline", user_id: "user-pipeline", since: observedAt - 1, until: observedAt + 100,
    })).rejects.toThrow()

    const encoded = JSON.stringify(captured)
    for (const forbidden of ["prompt", "response", "directory", "authorization", "api_key", "/Users/"]) {
      expect(encoded.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }

    await t.run(async (ctx) => {
      for (const table of ["llm_usage_events", "llm_usage_revisions"] as const) {
        for (const row of await ctx.db.query(table).collect()) await ctx.db.patch(row._id, { created_at: 1 })
      }
    })
    await t.mutation(internal.usageMetering.pruneUsageFacts, { retain_ms: 400 * 86_400_000, now: observedAt + 100, limit: 100 })
    const afterRetention = await central.usageDashboard?.({
      org_id: "org-pipeline", user_id: "user-pipeline", since: observedAt - 1, until: observedAt + 100,
    }) as any
    expect(afterRetention.totals).toMatchObject({ turn_count: 2, input_tokens: 20 })
  })

  test("accepts, deduplicates, rejects conflicts/stale writes, and replaces the daily contribution", async () => {
    const t = convexTest(schema, modules)
    const ingest = (revision: Record<string, unknown>) => t.mutation(api.usageMetering.ingestTurnUsageBatch, {
      ...SERVICE,
      org_id: "org_1",
      user_id: "user_sub_1",
      revisions: [revision],
      now: Date.UTC(2026, 6, 11),
    } as never)

    await expect(ingest(REVISION)).resolves.toMatchObject({ results: [{ status: "accepted", revision: 1 }] })
    await expect(ingest(REVISION)).resolves.toMatchObject({ results: [{ status: "duplicate", revision: 1 }] })
    await expect(ingest({ ...REVISION, output_tokens: 99 })).resolves.toMatchObject({
      results: [{ status: "conflict", revision: 1, current_revision: 1 }],
    })
    await expect(ingest({ ...REVISION, revision: 0 })).rejects.toThrow("positive integer")

    const final = {
      ...REVISION,
      revision: 2,
      settlement: "final" as const,
      status: "completed" as const,
      completed_at: Date.UTC(2026, 6, 10, 0, 1),
      output_tokens: 40,
    }
    await expect(ingest(final)).resolves.toMatchObject({ results: [{ status: "accepted", revision: 2 }] })
    await expect(ingest(REVISION)).resolves.toMatchObject({
      results: [{ status: "stale", revision: 1, current_revision: 2 }],
    })

    const dashboard: any = await t.query(api.usageMetering.usageDashboard, {
      ...SERVICE,
      org_id: "org_1",
      user_id: "user_sub_1",
      since: Date.UTC(2026, 6, 1),
      until: Date.UTC(2026, 6, 31),
    } as never)
    expect(dashboard.totals).toMatchObject({
      turn_count: 1,
      input_tokens: 100,
      output_tokens: 40,
      partial_turn_count: 0,
      unavailable_turn_count: 0,
    })
    expect(dashboard.daily).toHaveLength(1)
    const breakdown: any = await t.query(api.usageMetering.usageBreakdown, {
      ...SERVICE,
      org_id: "org_1",
      user_id: "user_sub_1",
      since: Date.UTC(2026, 6, 1),
      until: Date.UTC(2026, 6, 31),
      dimension: "model",
    } as never)
    expect(breakdown.rows).toEqual([expect.objectContaining({
      value: "anthropic/claude-sonnet-5",
      turn_count: 1,
      output_tokens: 40,
    })])
    expect(await t.run(async (ctx) => ctx.db.query("llm_usage_revisions").collect())).toHaveLength(2)
  })

  test("scopes projections by tenant and rejects an invalid batch before writing any item", async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.usageMetering.ingestTurnUsageBatch, {
      ...SERVICE,
      org_id: "org_1",
      user_id: "user_sub_1",
      revisions: [REVISION],
    } as never)
    const foreign: any = await t.query(api.usageMetering.usageDashboard, {
      ...SERVICE,
      org_id: "org_2",
      user_id: "user_sub_1",
      since: REVISION.observed_at - 1,
      until: REVISION.observed_at + 1,
    } as never)
    expect(foreign.totals.turn_count).toBe(0)

    await expect(t.mutation(api.usageMetering.ingestTurnUsageBatch, {
      ...SERVICE,
      org_id: "org_1",
      user_id: "user_sub_1",
      revisions: [
        { ...REVISION, revision: 2 },
        { ...REVISION, message_id: "msg_bad", revision: 1, input_tokens: -1 },
      ],
    } as never)).rejects.toThrow("non-negative")
    const rows = await t.run(async (ctx) => ctx.db.query("llm_usage_events").collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]!.revision).toBe(1)
  })

  test("pages exact facts into client-timezone days and excludes adjacent timestamps", async () => {
    const t = convexTest(schema, modules)
    const start = Date.UTC(2026, 6, 10, 18, 0)
    await t.mutation(api.usageMetering.ingestTurnUsageBatch, {
      ...SERVICE,
      org_id: "org_1",
      user_id: "user_sub_1",
      revisions: [
        { ...REVISION, message_id: "before", observed_at: start - 1 },
        { ...REVISION, message_id: "late", observed_at: start, input_tokens: 7 },
        { ...REVISION, message_id: "next-day", observed_at: start + 3 * 60 * 60_000, input_tokens: 11 },
      ],
    } as never)

    const page: any = await t.query(api.usageMetering.usageDashboardPage, {
      ...SERVICE,
      org_id: "org_1",
      user_id: "user_sub_1",
      since: start,
      until: start + 3 * 60 * 60_000,
      time_zone: "Asia/Kolkata",
      dimension: "harness",
    } as never)
    expect(page.totals).toMatchObject({ turn_count: 2, input_tokens: 18 })
    expect(page.daily).toEqual([
      expect.objectContaining({ date: "2026-07-10", input_tokens: 7 }),
      expect.objectContaining({ date: "2026-07-11", input_tokens: 11 }),
    ])
    expect(page.breakdown).toEqual([expect.objectContaining({
      value: "claude-sdk", turn_count: 2, known_token_count: 6, unknown_token_count: 4,
    })])
  })

  test("filters exact facts while returning unfiltered filter options and pricing dimensions", async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.usageMetering.ingestTurnUsageBatch, {
      ...SERVICE,
      org_id: "org_1",
      user_id: "user_sub_1",
      revisions: [
        REVISION,
        { ...REVISION, message_id: "msg_2", harness: "codex", provider_id: "openai", model_id: "gpt-5", location: "central", input_tokens: 50 },
      ],
    } as never)
    const page: any = await t.query(api.usageMetering.usageDashboardPage, {
      ...SERVICE,
      org_id: "org_1",
      user_id: "user_sub_1",
      since: REVISION.observed_at - 1,
      until: REVISION.observed_at + 1,
      time_zone: "UTC",
      dimension: "harness",
      filter_harness: "codex",
    } as never)
    expect(page.totals).toMatchObject({ turn_count: 1, input_tokens: 50 })
    expect(page.breakdown).toEqual([expect.objectContaining({ value: "codex", turn_count: 1 })])
    expect(page.daily_models).toEqual([expect.objectContaining({ value: "openai/gpt-5", input_tokens: 50 })])
    expect(page.breakdown_models).toEqual([expect.objectContaining({ group: "codex", value: "openai/gpt-5", input_tokens: 50 })])
    expect(page.filters).toMatchObject({
      provider: ["anthropic", "openai"],
      harness: ["claude-sdk", "codex"],
      location: ["cloud", "local"],
    })

    const provider: any = await t.query(api.usageMetering.usageDashboardPage, {
      ...SERVICE,
      org_id: "org_1",
      user_id: "user_sub_1",
      since: REVISION.observed_at - 1,
      until: REVISION.observed_at + 1,
      time_zone: "UTC",
      dimension: "provider",
      filter_provider: "openai",
    } as never)
    expect(provider.totals).toMatchObject({ turn_count: 1, input_tokens: 50 })
    expect(provider.breakdown).toEqual([expect.objectContaining({ value: "openai", turn_count: 1 })])
  })

  test("rejects oversized batches without a partial write", async () => {
    const t = convexTest(schema, modules)
    await expect(t.mutation(api.usageMetering.ingestTurnUsageBatch, {
      ...SERVICE,
      org_id: "org_1",
      user_id: "user_sub_1",
      revisions: Array.from({ length: 101 }, (_, index) => ({ ...REVISION, message_id: `msg_${index}` })),
    } as never)).rejects.toThrow("at most 100")
    expect(await t.run(async (ctx) => ctx.db.query("llm_usage_events").collect())).toHaveLength(0)
  })
})

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
    const t = convexTest(schema, modules)

    await t.mutation(api.sandboxLeases.acquire, {
      ...SERVICE,
      workspace_id: "ws_1",
      home_region: "us-east",
      driver: "daytona",
      stale_after_ms: 60_000,
      org_id: "org_1",
      user_id: "user_sub_1",
      now: opened,
    } as never)

    const released: any = await t.mutation(api.sandboxLeases.release, {
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
    const events = await t.run(async (ctx) => ctx.db.query("sandbox_lease_events").collect())
    expect(events).toHaveLength(1)
  })

  test("the reaper closes a heartbeat-silent lease as idle, once", async () => {
    const opened = 5_000_000
    const t = convexTest(schema, modules)
    await seedLease(t, {
      org_id: "org_1",
      user_id: "user_sub_1",
      started_at: opened,
      last_heartbeat_at: opened,
    })

    const first = await t.mutation(internal.sandboxLeases.sweepStaleLeases, {
      acquiring_stale_after_ms: 900_000,
      ready_heartbeat_stale_after_ms: 1_800_000,
      now: opened + 2_000_000,
    } as never)
    expect(first).toMatchObject({ marked_stopped: 1, closed_intervals: 1 })

    const facts = await t.run(async (ctx) => ctx.db.query("sandbox_lease_events").collect())
    expect(facts[0]).toMatchObject({ reason: "idle_timeout", active_ms: 2_000_000, date: "1970-01-01" })

    // A reaper that re-runs over the same stopped lease must not invent
    // compute: the row now carries `ended_at`, so the close predicate is false.
    const second = await t.mutation(internal.sandboxLeases.sweepStaleLeases, {
      acquiring_stale_after_ms: 900_000,
      ready_heartbeat_stale_after_ms: 1_800_000,
      now: opened + 9_000_000,
    } as never)
    expect(second.closed_intervals).toBe(0)
    const factsAfter = await t.run(async (ctx) => ctx.db.query("sandbox_lease_events").collect())
    expect(factsAfter).toHaveLength(1)
  })

  test("re-acquiring a stopped lease opens a fresh interval instead of extending the old one", async () => {
    const t = convexTest(schema, modules)
    await seedLease(t, {
      status: "stopped",
      org_id: "org_1",
      user_id: "user_sub_1",
      started_at: 1_000,
      ended_at: 2_000,
    })

    await t.mutation(api.sandboxLeases.acquire, {
      ...SERVICE,
      workspace_id: "ws_1",
      home_region: "us-east",
      driver: "daytona",
      stale_after_ms: 60_000,
      now: 10_000,
    } as never)
    const afterAcquire = await t.run(async (ctx) =>
      ctx.db.query("runtime_leases").withIndex("by_workspace_id", (q) => q.eq("workspace_id", "ws_1")).first())
    expect(afterAcquire).toMatchObject({ started_at: 10_000 })
    expect(afterAcquire!.ended_at).toBeUndefined()

    const released: any = await t.mutation(api.sandboxLeases.release, {
      ...SERVICE,
      workspace_id: "ws_1",
      now: 25_000,
    } as never)
    expect(released.usage.active_ms).toBe(15_000)
  })

  test("a lease with no tenant records no fact rather than a fabricated one", async () => {
    const t = convexTest(schema, modules)
    await seedLease(t, { started_at: 1_000 })

    const released: any = await t.mutation(api.sandboxLeases.release, {
      ...SERVICE,
      workspace_id: "ws_1",
      now: 61_000,
    } as never)
    expect(released.released).toBe(true)
    expect(released.usage).toBeNull()
    const events = await t.run(async (ctx) => ctx.db.query("sandbox_lease_events").collect())
    expect(events).toHaveLength(0)
  })

  test("recordTenant attributes an unattributed lease and never re-attributes one", async () => {
    const t = convexTest(schema, modules)
    await seedLease(t, { started_at: 1_000 })

    await expect(t.mutation(api.sandboxLeases.recordTenant, {
      ...SERVICE,
      workspace_id: "ws_1",
      org_id: "org_1",
      user_id: "user_sub_1",
    } as never)).resolves.toMatchObject({ stamped: true })
    let row = await t.run(async (ctx) =>
      ctx.db.query("runtime_leases").withIndex("by_workspace_id", (q) => q.eq("workspace_id", "ws_1")).first())
    expect(row).toMatchObject({ org_id: "org_1", user_id: "user_sub_1" })

    await expect(t.mutation(api.sandboxLeases.recordTenant, {
      ...SERVICE,
      workspace_id: "ws_1",
      org_id: "org_attacker",
      user_id: "user_attacker",
    } as never)).resolves.toMatchObject({ stamped: false, reason: "already_attributed" })
    row = await t.run(async (ctx) =>
      ctx.db.query("runtime_leases").withIndex("by_workspace_id", (q) => q.eq("workspace_id", "ws_1")).first())
    expect(row).toMatchObject({ org_id: "org_1" })

    await expect(t.mutation(api.sandboxLeases.recordTenant, {
      ...SERVICE,
      workspace_id: "ws_absent",
      org_id: "org_1",
      user_id: "user_sub_1",
    } as never)).resolves.toMatchObject({ stamped: false, reason: "no_lease" })
  })
})

describe("user_activated is an idempotent check-and-set", () => {
  async function seedUser(t: ReturnType<typeof convexTest>) {
    return t.run(async (ctx) => ctx.db.insert("users", stamped({
      token_identifier: "tok_1",
      clerk_subject: "user_sub_1",
    }) as never))
  }

  test("an error turn then an ok turn fires exactly once; a third turn does not re-fire", async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t)
    const run = (input: Record<string, unknown>) =>
      t.mutation(api.usageMetering.recordLlmTurn, {
        ...SERVICE,
        ...TURN,
        message_id: `msg_${input.now}`,
        ...input,
      } as never)

    const errored: any = await run({ turn_status: "error", now: 1_000 })
    expect(errored.activated).toBe(false)
    let user = await t.run(async (ctx) => ctx.db.get(userId))
    expect(user!.first_activated_at).toBeUndefined()

    const first: any = await run({ turn_status: "ok", now: 2_000 })
    expect(first.activated).toBe(true)
    user = await t.run(async (ctx) => ctx.db.get(userId))
    expect(user!.first_activated_at).toBe(2_000)

    const third: any = await run({ turn_status: "ok", now: 3_000 })
    expect(third.activated).toBe(false)
    // The stamp is the first ok turn's moment for all time, not the latest.
    user = await t.run(async (ctx) => ctx.db.get(userId))
    expect(user!.first_activated_at).toBe(2_000)

    // Every turn is still recorded as usage — activation is a separate question.
    const events = await t.run(async (ctx) => ctx.db.query("llm_usage_events").collect())
    expect(events).toHaveLength(3)
  })

  test("an unmatched subject records usage and creates no user", async () => {
    const t = convexTest(schema, modules)
    const result: any = await t.mutation(api.usageMetering.recordLlmTurn, { ...SERVICE, ...TURN, now: 9 } as never)
    expect(result.activated).toBe(false)
    const events = await t.run(async (ctx) => ctx.db.query("llm_usage_events").collect())
    expect(events).toHaveLength(1)
    const users = await t.run(async (ctx) => ctx.db.query("users").collect())
    expect(users).toHaveLength(0)
  })

  test("the recorded row carries the turn verbatim and no service token", async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.usageMetering.recordLlmTurn, { ...SERVICE, ...TURN, now: 42 } as never)
    const events = await t.run(async (ctx) => ctx.db.query("llm_usage_events").collect())
    const row = events[0]!
    expect(row).toMatchObject({ ...TURN, created_at: 42 })
    expect(row).not.toHaveProperty("service_token")
    expect(row).not.toHaveProperty("now")
  })

  test("an exact Session message retry records usage once", async () => {
    const t = convexTest(schema, modules)
    const input = { ...SERVICE, ...TURN, now: 42 }
    const first: any = await t.mutation(api.usageMetering.recordLlmTurn, input as never)
    const retry: any = await t.mutation(api.usageMetering.recordLlmTurn, input as never)

    expect(retry.id).toBe(first.id)
    const events = await t.run(async (ctx) => ctx.db.query("llm_usage_events").collect())
    expect(events).toHaveLength(1)
  })
})

describe("hosted WorkGraph usage attribution", () => {
  async function fixture(t: ReturnType<typeof convexTest>) {
    return t.run(async (ctx) => {
      const orgId = await ctx.db.insert("orgs", stamped({ name: "Acme", clerk_org_id: "org_1" }) as never)
      const userId = await ctx.db.insert("users", stamped({ token_identifier: "tok_1", clerk_subject: "user_sub_1" }) as never)
      await ctx.db.insert("org_memberships", stamped({ org_id: orgId, user_id: userId, role: "member" }) as never)
      return { orgId, userId }
    })
  }

  test("derives Run ownership from the deterministic Session ID", async () => {
    const t = convexTest(schema, modules)
    const { orgId, userId } = await fixture(t)
    await t.run(async (ctx) => ctx.db.insert("workgraph_runs", stamped({
      organization_id: orgId,
      owner_user_id: userId,
      id: "run_hosted",
      stream_id: "stream_hosted",
      work_item_id: "item_hosted",
      run_number: 1,
      generation: 1,
      state: "running",
      resolved_execution: {},
      admitted_at: 1,
      source_revision_refs: [],
      provenance: {},
      row_version: 1,
      schema_version: 1,
    }) as never))

    await expect(t.query(api.usageMetering.resolveWorkGraphAttribution, {
      ...SERVICE,
      org_id: "org_1",
      user_id: "user_sub_1",
      session_id: "ses_wgrun_run_hosted",
    } as never)).resolves.toEqual({
      stream_id: "stream_hosted",
      run_id: "run_hosted",
      work_item_id: "item_hosted",
    })
  })

  test("rejects a Run owned by another organization", async () => {
    const t = convexTest(schema, modules)
    const { userId } = await fixture(t)
    const foreignOrgId = await t.run(async (ctx) => ctx.db.insert("orgs", stamped({ name: "Foreign", clerk_org_id: "org_foreign" }) as never))
    await t.run(async (ctx) => ctx.db.insert("workgraph_runs", stamped({
      organization_id: foreignOrgId,
      owner_user_id: userId,
      id: "run_hosted",
      stream_id: "stream_foreign",
      work_item_id: "item_foreign",
      run_number: 1,
      generation: 1,
      state: "running",
      resolved_execution: {},
      admitted_at: 1,
      source_revision_refs: [],
      provenance: {},
      row_version: 1,
      schema_version: 1,
    }) as never))

    // Real-schema/real-boundary finding: the old `_handler` reach-in observed
    // the handler's raw `return` value (JS `undefined`). Through the actual
    // Convex query boundary — which convex-test's `t.query` exercises —
    // `undefined` is not a representable Convex value and is delivered to the
    // caller as `null`, not `undefined`. This is real production behavior,
    // not a test artifact, so the assertion is updated rather than the
    // production code.
    await expect(t.query(api.usageMetering.resolveWorkGraphAttribution, {
      ...SERVICE,
      org_id: "org_1",
      user_id: "user_sub_1",
      session_id: "ses_wgrun_run_hosted",
    } as never)).resolves.toBeNull()
  })

  test("derives master Session attribution from its owned Stream", async () => {
    const t = convexTest(schema, modules)
    const { orgId, userId } = await fixture(t)
    await t.run(async (ctx) => ctx.db.insert("workgraph_streams", stamped({
      organization_id: orgId,
      owner_user_id: userId,
      id: "stream_hosted",
      workgraph_id: "wg_1",
      title: "Stream",
      lifecycle_state: "active",
      visibility: "private",
      pinned: false,
      execution_defaults: {},
      activity: {},
      durable_effect_count: 0,
      source_revision_refs: [],
      provenance: {},
      row_version: 1,
      schema_version: 1,
    }) as never))

    await expect(t.query(api.usageMetering.resolveWorkGraphAttribution, {
      ...SERVICE,
      org_id: "org_1",
      user_id: "user_sub_1",
      session_id: "ses_master_stream_hosted",
    } as never)).resolves.toEqual({ stream_id: "stream_hosted" })
  })

  test("derives source-planning Session attribution from proposal evidence", async () => {
    const t = convexTest(schema, modules)
    const { orgId, userId } = await fixture(t)
    await t.run(async (ctx) => ctx.db.insert("workgraph_admission_proposals", stamped({
      organization_id: orgId,
      owner_user_id: userId,
      id: "proposal_hosted",
      workgraph_id: "wg_1",
      state: "pending",
      proposal_kind: "intake",
      planning_evidence: { targetStreamId: "stream_planned" },
      provenance: {},
      row_version: 1,
      schema_version: 1,
    }) as never))

    await expect(t.query(api.usageMetering.resolveWorkGraphAttribution, {
      ...SERVICE,
      org_id: "org_1",
      user_id: "user_sub_1",
      session_id: "ses_workgraph_source_plan_job_proposal_hosted_1",
    } as never)).resolves.toEqual({ stream_id: "stream_planned" })
  })
})

describe("readers make every metering table reachable", () => {
  test("llmUsageForSession and llmUsageTotals answer the per-user question", async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.usageMetering.recordLlmTurn, { ...SERVICE, ...TURN, now: 100 } as never)
    await t.mutation(api.usageMetering.recordLlmTurn, {
      ...SERVICE,
      ...TURN,
      user_id: "user_sub_2",
      session_id: "s_2",
      turn_status: "error",
      now: 200,
    } as never)

    await expect(t.query(api.usageMetering.llmUsageForSession, { ...SERVICE, session_id: "s_1" } as never))
      .resolves.toHaveLength(1)

    const totals: any = await t.query(api.usageMetering.llmUsageTotals, { ...SERVICE, org_id: "org_1" } as never)
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
    const t = convexTest(schema, modules)
    await seedLease(t, {
      org_id: "org_1",
      user_id: "user_sub_1",
      sandbox_id: "sbx_9",
      started_at: 1_000,
    })
    await t.mutation(api.sandboxLeases.release, { ...SERVICE, workspace_id: "ws_1", now: 31_000 } as never)

    await expect(t.query(api.usageMetering.leaseEventsForSandbox, { ...SERVICE, sandbox_id: "sbx_9" } as never))
      .resolves.toMatchObject([{ sandbox_id: "sbx_9", active_ms: 30_000 }])
  })
})

describe("the rollup and retention crons keep the answer bounded and honest", () => {
  // `sandbox_lease_events` has no `updated_at` column — `stamped()` is NOT
  // used here (unlike every other table in this suite) because it would add
  // an unvalidated field.
  const fact = (overrides: Record<string, unknown> = {}) => ({
    org_id: "org_1",
    user_id: "user_sub_1",
    workspace_id: "ws_1",
    sandbox_id: "sbx_1",
    driver: "daytona",
    started_at: 0,
    ended_at: 30_000,
    active_ms: 30_000,
    reason: "explicit_release" as const,
    date: "2026-07-28",
    created_at: 30_000,
    ...overrides,
  })

  test("facts fold into daily buckets in seconds and are consumed exactly once", async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert("sandbox_lease_events", fact() as never)
      await ctx.db.insert("sandbox_lease_events", fact({ active_ms: 90_000 }) as never)
      await ctx.db.insert("sandbox_lease_events", fact({ user_id: "user_sub_2", active_ms: 10_000 }) as never)
    })

    const first = await t.mutation(internal.usageMetering.rollupSandboxUsageDaily, { now: 99 } as never)
    expect(first).toMatchObject({ rolled_up: 3, buckets_created: 2 })

    const buckets = await t.run(async (ctx) => ctx.db.query("sandbox_usage_daily").collect())
    expect(buckets.find((row) => row.user_id === "user_sub_1")).toMatchObject({
      total_active_seconds: 120,
      lease_count: 2,
      date: "2026-07-28",
      driver: "daytona",
    })

    // Re-running is the whole point of a level-triggered cron: a second pass
    // over already-consumed facts must add nothing.
    const second = await t.mutation(internal.usageMetering.rollupSandboxUsageDaily, { now: 200 } as never)
    expect(second).toMatchObject({ rolled_up: 0, buckets_created: 0 })
    const bucketsAfter = await t.run(async (ctx) => ctx.db.query("sandbox_usage_daily").collect())
    expect(bucketsAfter).toHaveLength(2)

    const daily: any = await t.query(api.usageMetering.sandboxUsageDaily, { ...SERVICE, org_id: "org_1" } as never)
    expect(daily).toMatchObject({ total_active_seconds: 130, lease_count: 3, user_count: 2 })
    expect(daily.active_seconds_per_user).toBe(65)
  })

  test("legacy turn rows backfill once before they become retention-eligible", async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => ctx.db.insert("llm_usage_events", { ...TURN, created_at: 1_000 } as never))
    await expect(t.run(async (ctx) => {
      const row = (await ctx.db.query("llm_usage_events").collect())[0]!
      return await migrateLegacyLlmUsageRow(ctx, row, 2_000)
    })).resolves.toBe(true)
    await expect(t.run(async (ctx) => {
      const row = (await ctx.db.query("llm_usage_events").collect())[0]!
      return await migrateLegacyLlmUsageRow(ctx, row, 3_000)
    })).resolves.toBe(false)
    const rows = await t.run(async (ctx) => ctx.db.query("llm_usage_events").collect())
    expect(rows[0]).toMatchObject({ revision: 1, settlement: "final", usage_rolled_up_at: 2_000 })
    expect(await t.run(async (ctx) => ctx.db.query("llm_usage_revisions").collect())).toHaveLength(1)
  })

  test("retention prunes aged facts, keeps rollups, and never drops an uncounted fact", async () => {
    const now = 400 * 24 * 60 * 60 * 1000 + 1_000_000
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert("sandbox_lease_events", fact({ created_at: 1_000, rolled_up_at: 2_000 }) as never)
      await ctx.db.insert("sandbox_lease_events", fact({ created_at: 1_000 }) as never)
      await ctx.db.insert("sandbox_lease_events", fact({ created_at: now - 1_000, rolled_up_at: now }) as never)
      await ctx.db.insert("sandbox_usage_daily", stamped({
        org_id: "org_1",
        user_id: "user_sub_1",
        date: "2026-07-28",
        driver: "daytona",
        total_active_seconds: 120,
        lease_count: 2,
        created_at: 1,
        updated_at: 1,
      }) as never)
      await ctx.db.insert("llm_usage_events", { ...TURN, created_at: 1_000, usage_rolled_up_at: 2_000 } as never)
      await ctx.db.insert("llm_usage_events", { ...TURN, created_at: now - 1_000 } as never)
    })

    const result = await t.mutation(internal.usageMetering.pruneUsageFacts, {
      retain_ms: 400 * 24 * 60 * 60 * 1000,
      now,
    } as never)
    expect(result).toMatchObject({ lease_events_deleted: 1, llm_usage_events_deleted: 1 })

    const leaseEvents = await t.run(async (ctx) => ctx.db.query("sandbox_lease_events").collect())
    // Aged AND rolled up: pruned.
    expect(leaseEvents.some((row) => row.created_at === 1_000 && row.rolled_up_at === 2_000)).toBe(false)
    // Aged but never rolled up: pruning it would erase compute the daily table
    // has not yet counted.
    expect(leaseEvents.some((row) => row.created_at === 1_000 && row.rolled_up_at === undefined)).toBe(true)
    expect(leaseEvents.some((row) => row.created_at === now - 1_000)).toBe(true)

    const turnEvents = await t.run(async (ctx) => ctx.db.query("llm_usage_events").collect())
    expect(turnEvents.some((row) => row.created_at === now - 1_000)).toBe(true)

    // The rollup is the long-range answer and survives the prune.
    const buckets = await t.run(async (ctx) => ctx.db.query("sandbox_usage_daily").collect())
    expect(buckets).toHaveLength(1)
  })
})

describe("the Convex function is the boundary", () => {
  test("every metering function rejects a wrong service token", async () => {
    const t = convexTest(schema, modules)
    await seedLease(t, { started_at: 1 })
    const wrong = { service_token: "wrong" }

    await expect(t.mutation(api.usageMetering.recordLlmTurn, { ...wrong, ...TURN } as never))
      .rejects.toThrow("Unauthenticated")
    await expect(t.query(api.usageMetering.llmUsageForSession, { ...wrong, session_id: "s_1" } as never))
      .rejects.toThrow("Unauthenticated")
    await expect(t.query(api.usageMetering.llmUsageTotals, wrong as never)).rejects.toThrow("Unauthenticated")
    await expect(t.query(api.usageMetering.leaseEventsForSandbox, { ...wrong, sandbox_id: "sbx_1" } as never))
      .rejects.toThrow("Unauthenticated")
    await expect(t.query(api.usageMetering.sandboxUsageDaily, wrong as never)).rejects.toThrow("Unauthenticated")
    await expect(t.mutation(api.sandboxLeases.recordTenant, {
      ...wrong,
      workspace_id: "ws_1",
      org_id: "org_x",
      user_id: "user_x",
    } as never)).rejects.toThrow("Unauthenticated")
  })

  test("an unset service-token secret fails closed, even for a matching empty token", async () => {
    vi.unstubAllEnvs()
    delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
    const t = convexTest(schema, modules)

    await expect(t.mutation(api.usageMetering.recordLlmTurn, { service_token: "", ...TURN } as never))
      .rejects.toThrow("Unauthenticated")
    await expect(t.mutation(api.usageMetering.recordLlmTurn, { service_token: "svc_secret", ...TURN } as never))
      .rejects.toThrow("Unauthenticated")
    const events = await t.run(async (ctx) => ctx.db.query("llm_usage_events").collect())
    expect(events).toHaveLength(0)
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
      ingestTurnUsageBatch,
      usageDashboard,
      usageBreakdown,
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
