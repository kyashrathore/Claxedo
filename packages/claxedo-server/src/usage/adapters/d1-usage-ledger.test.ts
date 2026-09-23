import { afterEach, describe, expect, test } from "vitest"
import type { TurnUsageRevision } from "@claxedo/server-core/usage/contracts"
import { LocalUsageRoutes, UsageRoutes } from "@claxedo/server-core/usage/routes"
import { tokenTrackerPricing } from "@claxedo/server-core/usage/adapters/token-tracker-pricing"
import { controlPlaneMigrations, miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../../test-support/control-plane-migrations"
import { createD1UsageLedger } from "./d1-usage-ledger"

const databases: ControlPlaneDatabase[] = []

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.dispose()))
})

async function ledger() {
  const database = await miniflareControlPlaneDatabase(controlPlaneMigrations())
  databases.push(database)
  return createD1UsageLedger({ database: database.database, now: () => 7_000 })
}

const DAY = Date.parse("2026-09-20T10:00:00Z")
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
  test("keeps each turn's latest revision and answers a replay by revision and payload", async () => {
    const store = await ledger()
    const first = cloud({ messageId: "msg_1", revision: 1, settlement: "provisional", status: "running" })
    const final = cloud({ messageId: "msg_1", revision: 2 })

    expect(await store.writeRevision(first, { owner: ALICE })).toEqual({ status: "accepted" })
    expect(await store.writeRevision(final, { owner: ALICE })).toEqual({ status: "accepted" })
    expect(await store.writeRevision(final, { owner: ALICE })).toEqual({ status: "duplicate" })
    expect(await store.writeRevision({ ...final, tokens: { ...final.tokens, output: 1 } }, { owner: ALICE }))
      .toEqual({ status: "conflict", currentRevision: 2 })
    expect(await store.writeRevision(first, { owner: ALICE })).toEqual({ status: "stale", currentRevision: 2 })
    await expect(store.writeRevision(cloud({ messageId: "msg_unowned" }))).rejects.toThrow(/account that produced it/)

    const projection = await store.usageDashboard({ ...ALICE, since: DAY - 1, until: DAY + 1, timeZone: "UTC" }) as {
      totals: Record<string, number>
    }
    expect(projection.totals).toMatchObject({ turn_count: 1, output_tokens: 400, partial_turn_count: 0 })
  })

  test("projects one account's turns, with the one-hour cache share per model, and nothing of anyone else's", async () => {
    const store = await ledger()
    await store.writeRevision(cloud({ messageId: "msg_a1" }), { owner: ALICE })
    await store.writeRevision(cloud({
      messageId: "msg_a2",
      observedAt: DAY + 86_400_000,
      settlement: "partial",
      status: "stopped",
      providerId: "openai",
      modelId: "gpt-5.4",
      tokens: { input: 50, output: null, reasoning: 5, cache: { read: null, write: null } },
    }), { owner: ALICE })
    await store.writeRevision(cloud({ messageId: "msg_b1", sessionId: "ses_2", sessionRef: "workspace:ws_main:session:ses_2" }), { owner: BOB })
    await store.writeRevision(cloud({ messageId: "msg_m1", workspaceId: "ws_other", hostId: "workspace:ws_other", sessionRef: "workspace:ws_other:session:ses_1" }), { owner: MALLORY })

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

describe("the hosted usage view over the D1 ledger", () => {
  test("shows the signed account its cloud turns, priced with the one-hour cache share, and no one else's", async () => {
    const store = await ledger()
    const fact = cloud({ messageId: "msg_priced" })
    await store.writeRevision(fact, { owner: ALICE })
    await store.writeRevision(cloud({ messageId: "msg_bob", sessionId: "ses_2", sessionRef: "workspace:ws_main:session:ses_2" }), { owner: BOB })
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
    await store.writeRevision(mine, { owner: ALICE })
    await store.writeRevision(cloud({ messageId: "msg_a_late", observedAt: DAY + 2 * 86_400_000 }), { owner: ALICE })
    await store.writeRevision(cloud({
      messageId: "msg_a_local",
      hostId: "local_machine",
      sessionRef: "local:/work:session:ses_local",
      sessionId: "ses_local",
      location: "local",
    }), { owner: ALICE })
    await store.writeRevision(cloud({ messageId: "msg_b1", sessionId: "ses_2", sessionRef: "workspace:ws_main:session:ses_2" }), { owner: BOB })
    await store.writeRevision(cloud({ messageId: "msg_m1", workspaceId: "ws_other", hostId: "workspace:ws_other", sessionRef: "workspace:ws_other:session:ses_1" }), { owner: MALLORY })
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
    await store.writeRevision(cloud({ messageId: "msg_cloud" }), { owner: ALICE })
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
      local: { current: async () => [local], pendingOutbox: async () => [] },
      identity: async () => undefined,
      outbox: {
        flush: async () => ({ attempted: 0, delivered: 0, conflicts: 0, pending: 0 }),
        clearIdentity: async () => ({ attempted: 0, delivered: 0, conflicts: 0, pending: 0 }),
      },
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
