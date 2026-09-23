import { afterEach, describe, expect, test } from "vitest"
import type { D1Database } from "@cloudflare/workers-types"
import { usageRevisionHash, type TurnUsageRevision, type UsageOwner } from "@claxedo/server-core/usage/contracts"
import {
  centralProjectionSeries,
  groupUsageFactsBy,
  usageFactDimension,
  usageFactFilterOptions,
  usageFactMatches,
  usageDateFormatter,
  usageModelKey,
  usageSeriesFromFacts,
  type CentralUsageProjection,
  type CentralUsageRow,
  type UsageBreakdownDimension,
  type UsageFilters,
} from "@claxedo/server-core/usage/projection"
import { LocalUsageRoutes, UsageRoutes } from "@claxedo/server-core/usage/routes"
import { tokenTrackerPricing } from "@claxedo/server-core/usage/adapters/token-tracker-pricing"
import { USAGE_REPORT_MAX_MESSAGES_PER_TURN } from "@claxedo/server-core/usage/usage-report"
import { controlPlaneMigrations, miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../../test-support/control-plane-migrations"
import { createD1UsageLedger } from "./d1-usage-ledger"

const databases: ControlPlaneDatabase[] = []

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.dispose()))
})

async function controlPlane() {
  const database = await miniflareControlPlaneDatabase(controlPlaneMigrations())
  databases.push(database)
  return database.database
}

async function ledger() {
  return createD1UsageLedger({ database: await controlPlane(), now: () => 7_000 })
}

const DAY = Date.parse("2026-09-20T10:00:00Z")
const TURN = "msg_user_1"
const pricing = tokenTrackerPricing("bundled")
const ALICE = { org_id: "org_acme", user_id: "user_alice" }
const BOB = { org_id: "org_acme", user_id: "user_bob" }
const MALLORY = { org_id: "org_other", user_id: "user_mallory" }

function cloud(input: Partial<TurnUsageRevision> & { messageId: string }): TurnUsageRevision {
  return {
    sessionRef: "workspace:ws_main:session:ses_1",
    sessionId: "ses_1",
    workspaceId: "ws_main",
    hostId: "workspace:ws_main",
    location: "cloud-workspace",
    revision: 1,
    observedAt: DAY,
    completedAt: DAY + 1_000,
    settlement: "final",
    status: "completed",
    harness: "claude",
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5",
    tokens: { input: 1_000, output: 400, reasoning: null, cache: { read: 2_000, write: 600, write1h: 400 } },
    quality: { source: "provider", knownCategories: ["input", "output", "cache_read", "cache_write"] },
    ...input,
  }
}

describe("the D1 usage ledger", () => {
  test("a later revision updates a message's usage but never refiles it under another member or turn", async () => {
    const store = await ledger()
    const range = { since: DAY - 1, until: DAY + 1, limit: 10 }
    expect(await store.writeRevision(cloud({ messageId: "msg_1", revision: 1 }), { owner: ALICE, turnId: TURN })).toEqual({ status: "accepted" })
    expect(await store.writeRevision(
      cloud({ messageId: "msg_1", revision: 2, tokens: { input: 5, output: 1, reasoning: null, cache: { read: null, write: null } } }),
      { owner: BOB, turnId: "msg_user_bob" },
    )).toEqual({ status: "accepted" })

    expect(await store.cloudUsageFacts({ ...BOB, ...range })).toEqual([])
    expect(await store.cloudUsageFacts({ ...ALICE, ...range })).toEqual([expect.objectContaining({ messageId: "msg_1", revision: 2, tokens: expect.objectContaining({ input: 5 }) })])
  })

  test("keeps each turn's latest revision and answers a replay by revision and payload", async () => {
    const store = await ledger()
    const first = cloud({ messageId: "msg_1", revision: 1, settlement: "provisional", status: "running" })
    const final = cloud({ messageId: "msg_1", revision: 2 })

    expect(await store.writeRevision(first, { owner: ALICE, turnId: TURN })).toEqual({ status: "accepted" })
    expect(await store.writeRevision(final, { owner: ALICE, turnId: TURN })).toEqual({ status: "accepted" })
    expect(await store.writeRevision(final, { owner: ALICE, turnId: TURN })).toEqual({ status: "duplicate" })
    expect(await store.writeRevision({ ...final, tokens: { ...final.tokens, output: 1 } }, { owner: ALICE, turnId: TURN }))
      .toEqual({ status: "conflict", currentRevision: 2 })
    expect(await store.writeRevision(first, { owner: ALICE, turnId: TURN })).toEqual({ status: "stale", currentRevision: 2 })
    await expect(store.writeRevision(cloud({ messageId: "msg_unturned" }), { owner: ALICE, turnId: "" }))
      .rejects.toThrow(/account and the turn that produced it/)

    const projection = await store.usageDashboard({ ...ALICE, since: DAY - 1, until: DAY + 1, timeZone: "UTC" }) as {
      totals: Record<string, number>
    }
    expect(projection.totals).toMatchObject({ turn_count: 1, output_tokens: 400, partial_turn_count: 0 })
  })

  test("projects one account's turns, with the one-hour cache share per model, and nothing of anyone else's", async () => {
    const store = await ledger()
    await store.writeRevision(cloud({ messageId: "msg_a1" }), { owner: ALICE, turnId: TURN })
    await store.writeRevision(cloud({
      messageId: "msg_a2",
      observedAt: DAY + 86_400_000,
      settlement: "partial",
      status: "stopped",
      providerId: "openai",
      modelId: "gpt-5.4",
      tokens: { input: 50, output: null, reasoning: 5, cache: { read: null, write: null } },
    }), { owner: ALICE, turnId: TURN })
    await store.writeRevision(cloud({ messageId: "msg_b1", sessionId: "ses_2", sessionRef: "workspace:ws_main:session:ses_2" }), { owner: BOB, turnId: TURN })
    await store.writeRevision(cloud({ messageId: "msg_m1", workspaceId: "ws_other", hostId: "workspace:ws_other", sessionRef: "workspace:ws_other:session:ses_1" }), { owner: MALLORY, turnId: TURN })

    const range = { since: DAY - 3_600_000, until: DAY + 2 * 86_400_000, timeZone: "UTC" }
    const alice = await store.usageDashboard({ ...ALICE, ...range, dimension: "model" }) as {
      totals: Record<string, number>
      daily: Array<Record<string, unknown>>
      models: Array<Record<string, unknown>>
      locations: Array<Record<string, unknown>>
      breakdown: Array<Record<string, unknown>>
      filters: Record<string, string[]>
    }
    expect(alice.totals).toMatchObject({
      turn_count: 2,
      input_tokens: 1_050,
      output_tokens: 400,
      reasoning_tokens: 5,
      cache_read_tokens: 2_000,
      cache_write_tokens: 600,
      cache_write_1h_tokens: 400,
      output_known_count: 1,
      partial_turn_count: 1,
    })
    expect(alice.daily.map((row) => [row.date, row.turn_count])).toEqual([["2026-09-20", 1], ["2026-09-21", 1]])
    expect(alice.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: "anthropic/claude-sonnet-4-5", cache_write_tokens: 600, cache_write_1h_tokens: 400 }),
      expect.objectContaining({ value: "openai/gpt-5.4", cache_write_1h_tokens: 0 }),
    ]))
    expect(alice.locations).toEqual([expect.objectContaining({ value: "cloud", turn_count: 2 })])
    expect(alice.breakdown.map((row) => row.value)).toEqual(expect.arrayContaining(["anthropic/claude-sonnet-4-5", "openai/gpt-5.4"]))
    expect(alice.breakdown).toHaveLength(2)
    expect(alice.filters.session).toEqual(["workspace:ws_main:session:ses_1"])

    const filtered = await store.usageDashboard({ ...ALICE, ...range, filters: { provider: "openai" } }) as { totals: Record<string, number> }
    expect(filtered.totals).toMatchObject({ turn_count: 1, input_tokens: 50 })

    const bob = await store.usageDashboard({ ...BOB, ...range }) as { totals: Record<string, number> }
    expect(bob.totals).toMatchObject({ turn_count: 1, input_tokens: 1_000 })
    const aliceElsewhere = await store.usageDashboard({ org_id: MALLORY.org_id, user_id: ALICE.user_id, ...range }) as {
      totals: Record<string, number>
    }
    expect(aliceElsewhere.totals).toEqual({})
  })
})

describe("the D1 usage ledger under load", () => {
  test("answers a dashboard whose token sums pass SQLite's integer range instead of failing it", async () => {
    const database = await controlPlane()
    const store = createD1UsageLedger({ database, now: () => 7_000 })
    const huge = Number.MAX_SAFE_INTEGER
    await seed(database, Array.from({ length: 1_025 }, (_, index) => ({
      fact: cloud({ messageId: `msg_${index}`, tokens: { input: huge, output: 1, reasoning: null, cache: { read: null, write: null } } }),
      owner: ALICE,
      turnId: `msg_user_${index}`,
    })))

    const range = { since: DAY - 1, until: DAY + 1, timeZone: "UTC" }
    const totals = (await store.usageDashboard({ ...ALICE, ...range }) as CentralUsageProjection).totals
    expect(totals).toMatchObject({ turn_count: 1_025, output_tokens: 1_025 })
    expect(Number(totals?.input_tokens)).toBeGreaterThan(Number.MAX_SAFE_INTEGER * 1_024)
  })

  test("files at most the per-turn cap of messages under one turn of one session, and still takes a later revision of one it holds", async () => {
    const database = await controlPlane()
    const store = createD1UsageLedger({ database, now: () => 7_000 })
    await seed(database, Array.from({ length: USAGE_REPORT_MAX_MESSAGES_PER_TURN - 1 }, (_, index) => ({
      fact: cloud({ messageId: `msg_${index}` }),
      owner: ALICE,
      turnId: TURN,
    })))
    expect(await store.writeRevision(cloud({ messageId: "msg_last" }), { owner: ALICE, turnId: TURN })).toEqual({ status: "accepted" })

    expect(await store.writeRevision(cloud({ messageId: "msg_over" }), { owner: ALICE, turnId: TURN }))
      .toEqual({ status: "refused", code: "usage_turn_full" })
    expect(await store.writeRevision(cloud({ messageId: "msg_0", revision: 2 }), { owner: ALICE, turnId: TURN }))
      .toEqual({ status: "accepted" })
    expect(await store.writeRevision(cloud({ messageId: "msg_over" }), { owner: ALICE, turnId: "msg_user_2" }))
      .toEqual({ status: "accepted" })
    expect(await store.writeRevision(
      cloud({ messageId: "msg_over_elsewhere", sessionId: "ses_2", sessionRef: "workspace:ws_main:session:ses_2" }),
      { owner: ALICE, turnId: TURN },
    )).toEqual({ status: "accepted" })

    const range = { since: DAY - 1, until: DAY + 1, timeZone: "UTC" }
    const totals = (await store.usageDashboard({ ...ALICE, ...range }) as CentralUsageProjection).totals
    expect(totals).toMatchObject({ turn_count: USAGE_REPORT_MAX_MESSAGES_PER_TURN + 2 })
  })

  test("aggregates a 90-day range in SQL, returning one row per group, and agrees with the facts it groups", async () => {
    const returned: number[] = []
    const database = await controlPlane()
    const store = createD1UsageLedger({ database: countingRows(database, returned), now: () => 7_000 })
    const since = Date.parse("2026-08-10T00:00:00Z")
    const until = since + 90 * 86_400_000
    const models = [
      { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
      { providerId: "openai", modelId: "gpt-5.4" },
      { providerId: "openrouter", modelId: "moonshot/kimi-k2" },
    ]
    const facts: TurnUsageRevision[] = []
    for (let index = 0; index < 1_800; index += 1) {
      const session = index % 36
      const local = index % 11 === 0
      const { workspaceId, ...unplaced } = cloud({
        messageId: `msg_${index}`,
        sessionId: `ses_${session}`,
        sessionRef: local ? `local:/work:session:ses_${session}` : `workspace:ws_main:session:ses_${session}`,
        hostId: local ? "host_laptop" : "workspace:ws_main",
        location: local ? "local" : "cloud-workspace",
        // Spread over the range and over each hour, so days split across
        // local midnights and the November clock change.
        observedAt: since + Math.floor((index * 4_321_987) % (90 * 86_400_000)),
        settlement: index % 17 === 0 ? "partial" : index % 19 === 0 ? "unavailable" : index % 29 === 0 ? "provisional" : "final",
        status: index % 23 === 0 ? "error" : "completed",
        // A settled turn with no known category reported no usage, whatever
        // its settlement says: 31 keeps its counts, 37 has none at all.
        quality: { source: "provider", knownCategories: index % 31 === 0 || index % 37 === 0 ? [] : ["input", "output", "cache_read", "cache_write"] },
        ...models[index % models.length],
        tokens: index % 37 === 0
          ? { input: null, output: null, reasoning: null, cache: { read: null, write: null } }
          : index % 7 === 0
          ? { input: index, output: null, reasoning: null, cache: { read: null, write: index } }
          : { input: index, output: 2 * index, reasoning: index % 5, cache: { read: 3 * index, write: index, write1h: index % 3 } },
      })
      facts.push(index % 13 === 0 ? unplaced : { ...unplaced, ...(workspaceId ? { workspaceId } : {}) })
    }
    facts.push(cloud({ messageId: "msg_before", observedAt: since - 1 }), cloud({ messageId: "msg_after", observedAt: until + 1 }))
    const [written, ...seeded] = facts
    if (!written) throw new Error("the range holds facts")
    expect(await store.writeRevision(written, { owner: ALICE, turnId: TURN })).toEqual({ status: "accepted" })
    await seed(database, seeded.map((fact) => ({ fact, owner: ALICE, turnId: `turn_${fact.messageId}` })))
    await store.writeRevision(cloud({ messageId: "msg_bob", observedAt: since + 1_000 }), { owner: BOB, turnId: TURN })
    const inRange = facts.filter((fact) => fact.observedAt >= since && fact.observedAt <= until)

    const views: Array<{ timeZone: string; dimension?: UsageBreakdownDimension; filters?: UsageFilters }> = [
      { timeZone: "America/New_York" },
      { timeZone: "Asia/Kathmandu", dimension: "session", filters: { provider: "openai" } },
      { timeZone: "UTC", dimension: "model", filters: { location: "cloud" } },
      { timeZone: "America/New_York", dimension: "workspace" },
    ]
    for (const view of views) {
      returned.length = 0
      const projection = await store.usageDashboard({ ...ALICE, since, until, ...view }) as CentralUsageProjection
      const label = JSON.stringify(view)
      const matched = inRange.filter((fact) => usageFactMatches(fact, view.filters ?? {}))
      const formatDate = usageDateFormatter(view.timeZone)
      const date = (fact: TurnUsageRevision) => formatDate.format(new Date(fact.observedAt))
      const model = (fact: TurnUsageRevision) => usageModelKey(fact.providerId, fact.modelId)
      const location = (fact: TurnUsageRevision) => usageFactDimension(fact, "location")
      const group = (fact: TurnUsageRevision) => (view.dimension ? usageFactDimension(fact, view.dimension) : "")

      expect(centralProjectionSeries(projection), label)
        .toEqual(usageSeriesFromFacts({ facts: matched, since, until, timeZone: view.timeZone }))
      expect(projection.totals?.cache_write_1h_tokens, label)
        .toBe(matched.reduce((sum, fact) => sum + (fact.tokens.cache.write1h ?? 0), 0))
      expect(grouped(projection.models, ["value"]), label).toEqual(expected(matched, (fact) => [model(fact)]))
      expect(grouped(projection.dailyModels, ["date", "value"]), label).toEqual(expected(matched, (fact) => [date(fact), model(fact)]))
      expect(grouped(projection.locations, ["value"]), label).toEqual(expected(matched, (fact) => [location(fact)]))
      if (view.dimension) {
        expect(grouped(projection.breakdown, ["value"]), label).toEqual(expected(matched, (fact) => [group(fact)]))
        expect(grouped(projection.dailyBreakdown, ["date", "value"]), label)
          .toEqual(expected(matched, (fact) => [date(fact), group(fact)]))
        expect(grouped(projection.breakdownModels, ["group", "value"]), label)
          .toEqual(expected(matched, (fact) => [group(fact), model(fact)]))
      } else {
        expect(projection.breakdown, label).toBeUndefined()
      }
      expect(projection.filters, label).toEqual(usageFactFilterOptions(inRange))

      const groups = new Set(matched.map((fact) => JSON.stringify([date(fact), model(fact), location(fact), group(fact)])))
      const optionTuples = new Set(inRange.map((fact) => JSON.stringify(
        (["provider", "harness", "model", "location", "session", "workspace"] as const).map((name) => usageFactDimension(fact, name)),
      )))
      expect(returned.toSorted((a, b) => a - b), label).toEqual([groups.size, optionTuples.size].toSorted((a, b) => a - b))
      expect(Math.max(...returned), label).toBeLessThan(inRange.length / 2)
    }
  })
})

const SEEDED_COLUMNS = [
  "host_id", "session_ref", "session_id", "message_id", "revision", "payload_hash", "org_id", "user_id", "turn_id",
  "workspace_id", "observed_at", "completed_at", "settlement", "status", "location", "harness", "provider_id", "model_id",
  "native_session_id", "input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens", "cache_write_tokens",
  "cache_write_1h_tokens", "quality_json", "recorded_at",
] as const

/**
 * Rows as the ledger writes them, in one statement: miniflare answers each D1
 * statement in about 5ms, so thousands written one at a time take a minute.
 */
async function seed(database: D1Database, rows: ReadonlyArray<{ fact: TurnUsageRevision; owner: UsageOwner; turnId: string }>) {
  const values = await Promise.all(rows.map(async ({ fact, owner, turnId }) => [
    fact.hostId, fact.sessionRef, fact.sessionId, fact.messageId, fact.revision, await usageRevisionHash(fact),
    owner.org_id, owner.user_id, turnId, fact.workspaceId ?? null, fact.observedAt, fact.completedAt ?? null,
    fact.settlement, fact.status, fact.location, fact.harness, fact.providerId, fact.modelId, fact.nativeSessionId ?? null,
    fact.tokens.input, fact.tokens.output, fact.tokens.reasoning, fact.tokens.cache.read, fact.tokens.cache.write,
    fact.tokens.cache.write1h ?? null, JSON.stringify(fact.quality), 7_000,
  ]))
  await database.prepare(`
    insert into usage_turn_facts (${SEEDED_COLUMNS.join(", ")})
    select ${SEEDED_COLUMNS.map((_, index) => `json_extract(value, '$[${index}]')`).join(", ")} from json_each(?)
  `).bind(JSON.stringify(values)).run()
}

/** Rows `all()` handed back, per statement, from a database that otherwise behaves as `database`. */
function countingRows(database: D1Database, returned: number[]): D1Database {
  const statement = (prepared: ReturnType<D1Database["prepare"]>): ReturnType<D1Database["prepare"]> => new Proxy(prepared, {
    get(target, key) {
      if (key === "bind") return (...values: unknown[]) => statement(target.bind(...values))
      if (key === "all") {
        return async () => {
          const result = await target.all()
          returned.push(result.results.length)
          return result
        }
      }
      const value: unknown = Reflect.get(target, key)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  return new Proxy(database, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => statement(target.prepare(sql))
      const value: unknown = Reflect.get(target, key)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

/** Each row's grouping fields and the totals the usage series read, keyed as `expected` keys them. */
function grouped(rows: readonly CentralUsageRow[] | undefined, fields: readonly string[]) {
  return Object.fromEntries((rows ?? []).map((row) => [
    JSON.stringify(fields.map((field) => row[field])),
    centralProjectionSeries({ totals: row }).totals,
  ]))
}

function expected(facts: readonly TurnUsageRevision[], key: (fact: TurnUsageRevision) => string[]) {
  return Object.fromEntries(groupUsageFactsBy(facts, (fact) => JSON.stringify(key(fact)))
    .map(({ value, ...totals }) => [value, totals]))
}

describe("the hosted usage view over the D1 ledger", () => {
  test("shows the signed account its cloud turns, priced with the one-hour cache share, and no one else's", async () => {
    const store = await ledger()
    const fact = cloud({ messageId: "msg_priced" })
    await store.writeRevision(fact, { owner: ALICE, turnId: TURN })
    await store.writeRevision(cloud({ messageId: "msg_bob", sessionId: "ses_2", sessionRef: "workspace:ws_main:session:ses_2" }), { owner: BOB, turnId: TURN })
    const identities: Record<string, { org_id: string; user_id: string }> = { alice: ALICE, mallory: MALLORY }
    const routes = UsageRoutes({
      ledger: store,
      identity: async (request) => identities[request.headers.get("x-test-user") ?? ""],
      pricing,
    })
    const read = async (user: string) => {
      const response = await routes.request(`/?since=${DAY - 3_600_000}&until=${DAY + 3_600_000}&group=location`, {
        headers: { "x-test-user": user },
      })
      expect(response.status).toBe(200)
      return await response.json() as {
        claxedo: {
          totals: { turnCount: number }
          locationShare: { localTokens: number; cloudTokens: number }
          cost: { estimatedUsd: number }
          scope: string
        }
        breakdown: { rows: Array<{ value: string; label: string; turnCount: number }> }
      }
    }

    const alice = await read("alice")
    expect(alice.claxedo.scope).toBe("cross-machine")
    expect(alice.claxedo.totals.turnCount).toBe(1)
    expect(alice.claxedo.locationShare).toEqual({ localTokens: 0, cloudTokens: 4_000 })
    expect(alice.breakdown.rows).toEqual([expect.objectContaining({ value: "cloud", label: "Cloud", turnCount: 1 })])
    const tokens = { input: 1_000, output: 400, reasoning: 0, cacheRead: 2_000, cacheWrite: 600 }
    const priced = await pricing({ source: "anthropic", model: "claude-sonnet-4-5", tokens: { ...tokens, cacheWrite1h: 400 } })
    const unsplit = await pricing({ source: "anthropic", model: "claude-sonnet-4-5", tokens: { ...tokens, cacheWrite1h: null } })
    expect(priced.estimatedUsd).toBeGreaterThan(unsplit.estimatedUsd)
    expect(alice.claxedo.cost.estimatedUsd).toBeCloseTo(priced.estimatedUsd, 10)

    const mallory = await read("mallory")
    expect(mallory.claxedo.totals.turnCount).toBe(0)
    expect(mallory.claxedo.locationShare.cloudTokens).toBe(0)
    expect((await routes.request(`/?since=${DAY - 1}&until=${DAY + 1}`)).status).toBe(401)
  })
})

describe("the signed account's cloud turns, as the hosted plane hands them to a desktop", () => {
  test("answer only the caller's own cloud workspace turns in range, and nobody's without a signed session", async () => {
    const store = await ledger()
    const mine = cloud({ messageId: "msg_a1" })
    await store.writeRevision(mine, { owner: ALICE, turnId: TURN })
    await store.writeRevision(cloud({ messageId: "msg_a_late", observedAt: DAY + 2 * 86_400_000 }), { owner: ALICE, turnId: TURN })
    await store.writeRevision(cloud({
      messageId: "msg_a_local",
      hostId: "local_machine",
      sessionRef: "local:/work:session:ses_local",
      sessionId: "ses_local",
      location: "local",
    }), { owner: ALICE, turnId: TURN })
    await store.writeRevision(cloud({ messageId: "msg_b1", sessionId: "ses_2", sessionRef: "workspace:ws_main:session:ses_2" }), { owner: BOB, turnId: TURN })
    await store.writeRevision(cloud({ messageId: "msg_m1", workspaceId: "ws_other", hostId: "workspace:ws_other", sessionRef: "workspace:ws_other:session:ses_1" }), { owner: MALLORY, turnId: TURN })
    const identities: Record<string, { org_id: string; user_id: string }> = {
      alice: ALICE,
      bob: BOB,
      mallory: MALLORY,
      aliceElsewhere: { org_id: MALLORY.org_id, user_id: ALICE.user_id },
    }
    const routes = UsageRoutes({
      ledger: store,
      identity: async (request) => identities[request.headers.get("x-test-user") ?? ""],
      pricing,
    })
    const facts = async (user: string) => {
      const response = await routes.request(`/cloud-facts?since=${DAY - 3_600_000}&until=${DAY + 3_600_000}`, {
        headers: { "x-test-user": user },
      })
      expect(response.status).toBe(200)
      return ((await response.json()) as { facts: TurnUsageRevision[] }).facts
    }

    expect(await facts("alice")).toEqual([mine])
    expect((await facts("bob")).map((fact) => fact.messageId)).toEqual(["msg_b1"])
    expect((await facts("mallory")).map((fact) => fact.messageId)).toEqual(["msg_m1"])
    expect(await facts("aliceElsewhere")).toEqual([])
    const unsigned = await routes.request(`/cloud-facts?since=${DAY - 1}&until=${DAY + 1}`)
    expect(unsigned.status).toBe(401)
    expect(await unsigned.json()).toMatchObject({ error: { code: "signed_org_required" } })
  })

  test("are exactly what the desktop's own usage route merges beside this machine's turns", async () => {
    const store = await ledger()
    await store.writeRevision(cloud({ messageId: "msg_cloud" }), { owner: ALICE, turnId: TURN })
    const hosted = UsageRoutes({ ledger: store, identity: async () => ALICE, pricing })
    const range = `since=${DAY - 3_600_000}&until=${DAY + 3_600_000}`
    const answered = await (await hosted.request(`/cloud-facts?${range}`)).json() as { facts: TurnUsageRevision[] }

    const local = cloud({
      messageId: "msg_local",
      hostId: "local_machine",
      sessionRef: "local:/work:session:ses_local",
      sessionId: "ses_local",
      workspaceId: "wrk_local",
      location: "local",
      tokens: { input: 10, output: 5, reasoning: null, cache: { read: null, write: null } },
    })
    const sidecar = LocalUsageRoutes({
      local: { current: async () => [local], ownedBy: async () => [] },
      identity: async () => undefined,
      pricing,
    })
    const response = await sidecar.request(`/?${range}&timezone=UTC&group=location`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cloud: { status: "available", facts: answered.facts } }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      claxedo: { totals: { turnCount: 2 }, locationShare: { localTokens: 15, cloudTokens: 4_000 }, scope: "cross-machine" },
      breakdown: { rows: [expect.objectContaining({ value: "cloud" }), expect.objectContaining({ value: "local" })] },
    })
  })
})
