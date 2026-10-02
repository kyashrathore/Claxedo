import { describe, expect, test, vi } from "vitest"
import { ControlPlaneAuthError, controlPlaneAuthContext, type ControlPlaneTokenVerifier } from "@claxedo/server-core/platform/auth/auth"
import { UsageRoutes } from "@claxedo/server-core/usage/routes"
import { LocalUsageRoutes } from "@claxedo/server-core/usage/routes"
import { tokenTrackerPricing } from "@claxedo/server-core/usage/adapters/token-tracker-pricing"
import type { TurnUsageRevision } from "@claxedo/server-core/usage/contracts"

const pricing = tokenTrackerPricing("bundled")
const authConfig = { enabled: true as const, issuer: "https://auth.test", jwksUrl: "custom:test" }
// Only "valid" verifies. A fake that answers for every token cannot tell a
// route that authenticates from one that reads the bearer and trusts it.
const verifier: ControlPlaneTokenVerifier = async (token) => {
  if (token !== "valid") throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Bearer token is invalid")
  return {
    mode: "signed",
    token,
    user: { subject: "user_from_token", orgId: "org_from_token", tokenIdentifier: "token_1", issuer: authConfig.issuer },
  }
}
const identity = async (request: Request) => {
  const auth = await controlPlaneAuthContext(request, { config: authConfig, verifier })
  return auth.mode === "signed" && auth.user.orgId ? { org_id: auth.user.orgId, user_id: auth.user.subject } : undefined
}

describe("usage routes", () => {
  test("serves no sync endpoint and answers no sync counters", async () => {
    const app = UsageRoutes({
      pricing,
      identity,
      ledger: { usageDashboard: async () => ({ totals: {}, daily: [] }) },
    })
    const headers = { authorization: "Bearer valid" }

    expect((await app.request("/sync", { method: "POST", headers })).status).toBe(404)
    const body = await (await app.request("/?since=1&until=2", { headers })).json()
    expect(body).not.toHaveProperty("sync")
    expect(await (await app.request("/?since=1&until=2&view=quota", { headers })).json()).not.toHaveProperty("sync")
  })

  test("derives tenant from verified auth and never trusts query identity", async () => {
    const usageDashboard = vi.fn(async () => ({ totals: { turn_count: 1 }, daily: [], breakdown: [] }))
    const app = UsageRoutes({
      pricing,
      identity,
      ledger: { usageDashboard },
    })
    const response = await app.request(
      "/?since=1&until=2&view=claxedo&group=model&filter_location=cloud&org_id=attacker",
      {
        headers: { authorization: "Bearer valid" },
      },
    )
    expect(response.status).toBe(200)
    expect(usageDashboard).toHaveBeenCalledWith({
      org_id: "org_from_token",
      user_id: "user_from_token",
      since: 1,
      until: 2,
      timeZone: "UTC",
      dimension: "model",
      filters: { location: "cloud" },
    })
  })

  test("rejects unsigned, invalid ranges, and invalid group dimensions", async () => {
    const ledger = { usageDashboard: async () => ({}) }
    const app = UsageRoutes({ identity, ledger, pricing })
    expect((await app.request("/?since=1&until=2")).status).toBe(401)
    expect((await app.request("/?since=2&until=1", { headers: { authorization: "Bearer valid" } })).status).toBe(400)
    expect(
      (await app.request(`/?since=0&until=${91 * 86_400_000}`, { headers: { authorization: "Bearer valid" } })).status,
    ).toBe(400)
    expect(
      (await app.request("/?since=1&until=2&timezone=Mars/Olympus", { headers: { authorization: "Bearer valid" } }))
        .status,
    ).toBe(400)
    expect(
      (await app.request("/?since=1&until=2&group=org", { headers: { authorization: "Bearer valid" } })).status,
    ).toBe(400)
    expect(
      (await app.request("/?since=1&until=2&metric=turns", { headers: { authorization: "Bearer valid" } })).status,
    ).toBe(400)
  })

  test("refuses a bearer the verifier rejects, on both the read and the cloud facts", async () => {
    const usageDashboard = vi.fn(async () => ({ totals: {}, daily: [] }))
    const app = UsageRoutes({
      pricing,
      identity,
      ledger: { usageDashboard, cloudUsageFacts: async () => [] },
    })
    const headers = { authorization: "Bearer forged" }

    for (const request of [app.request("/?since=1&until=2", { headers }), app.request("/cloud-facts?since=1&until=2", { headers })]) {
      const response = await request
      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({
        error: { code: "invalid_bearer_token", message: "Bearer token is invalid", retryable: false },
      })
    }
    expect(usageDashboard).not.toHaveBeenCalled()
  })

  test("returns hosted quota capability without running usage projection or pricing", async () => {
    const usageDashboard = vi.fn(async () => {
      throw new Error("must not run")
    })
    const app = UsageRoutes({
      pricing,
      identity,
      ledger: { usageDashboard },
    })

    const response = await app.request("/?since=1&until=2&view=quota", {
      headers: { authorization: "Bearer valid" },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      quota: { status: "unavailable" },
      claxedo: { status: "unavailable" },
    })
    expect(usageDashboard).not.toHaveBeenCalled()
  })

  test("accepts a 90-calendar-day range containing a DST fall-back hour", async () => {
    const app = UsageRoutes({
      pricing,
      identity,
      ledger: {
        usageDashboard: async () => ({ totals: {}, daily: [] }),
      },
    })
    const response = await app.request(`/?since=0&until=${90 * 86_400_000 + 3_600_000}&timezone=America/New_York`, {
      headers: { authorization: "Bearer valid" },
    })
    expect(response.status).toBe(200)
  })

  test("prices Claxedo from the dashboard's own model rows and returns Claxedo in the app breakdown", async () => {
    const app = UsageRoutes({
      pricing,
      identity,
      ledger: {
        usageDashboard: async () => ({
          totals: { turn_count: 2, input_tokens: 12 },
          daily: [],
          models: [
            { value: "anthropic/claude-sonnet-5", input_tokens: 5 },
            { value: "openai/gpt-5", input_tokens: 7 },
          ],
        }),
      },
    })

    const response = await app.request("/?since=1&until=2&group=app", { headers: { authorization: "Bearer valid" } })
    const body = (await response.json())
    expect(body.breakdown).toEqual({
      dimension: "app",
      rows: [expect.objectContaining({ value: "Claxedo", turnCount: 2, input: 12 })],
    })
    expect(body.claxedo.cost.pricedTokens + body.claxedo.cost.unpricedTokens).toBe(12)
  })

  test("a row whose model has no price reads as unpriced even when some of its token categories are unknown", async () => {
    const app = UsageRoutes({
      pricing,
      identity,
      ledger: {
        usageDashboard: async () => ({
          totals: { turn_count: 2, input_tokens: 12, input_known_count: 2 },
          daily: [],
          models: [
            { value: "anthropic/claude-sonnet-5", input_tokens: 5 },
            { value: "nobody/model-with-no-price", input_tokens: 7 },
          ],
          breakdown: [
            { value: "priced", turn_count: 1, input_tokens: 5, known_token_count: 1, unknown_token_count: 4 },
            { value: "unpriced", turn_count: 1, input_tokens: 7, known_token_count: 1, unknown_token_count: 4 },
          ],
          breakdownModels: [
            { group: "priced", value: "anthropic/claude-sonnet-5", input_tokens: 5 },
            { group: "unpriced", value: "nobody/model-with-no-price", input_tokens: 7 },
          ],
        }),
      },
    })
    const body = (await (
      await app.request("/?since=1&until=2&view=claxedo&group=harness", { headers: { authorization: "Bearer valid" } })
    ).json())
    expect(body.breakdown.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: "priced", status: "partial" }),
      expect.objectContaining({ value: "unpriced", status: "unpriced" }),
    ]))
  })

  test("returns a canonical priced breakdown page from the exact dashboard projection", async () => {
    const app = UsageRoutes({
      pricing,
      identity,
      ledger: {
        usageDashboard: async () => ({
          totals: { turn_count: 2, input_tokens: 12, input_known_count: 2 },
          daily: [],
          dailyBreakdown: [
            { date: "2026-08-08", value: "a", input_tokens: 5 },
            { date: "2026-08-08", value: "b", input_tokens: 7 },
          ],
          models: [{ value: "anthropic/claude-sonnet-5", input_tokens: 12 }],
          breakdown: [
            { value: "a", turn_count: 1, input_tokens: 5, known_token_count: 1, unknown_token_count: 4 },
            { value: "b", turn_count: 1, input_tokens: 7, known_token_count: 1, unknown_token_count: 4 },
          ],
          breakdownModels: [
            { group: "a", value: "anthropic/claude-sonnet-5", input_tokens: 5 },
            { group: "b", value: "anthropic/claude-sonnet-5", input_tokens: 7 },
          ],
          filters: { harness: ["a", "b"], location: ["local"] },
        }),
      },
    })
    const body = (await (
      await app.request("/?since=1&until=2&view=claxedo&group=harness&limit=1", {
        headers: { authorization: "Bearer valid" },
      })
    ).json())
    expect(body.breakdown).toMatchObject({
      dimension: "harness",
      rows: [expect.objectContaining({ value: "b", input: 7, estimatedUsd: expect.any(Number), status: "partial" })],
      next: "b",
    })
    expect(body.modelBreakdown).toMatchObject({
      dimension: "model",
      rows: [expect.objectContaining({ value: "anthropic/claude-sonnet-5", input: 12 })],
    })
    expect(body.filterOptions.claxedo).toMatchObject({ harness: ["a", "b"], location: ["local"] })
    expect(body.chart).toEqual({
      dimension: "harness",
      series: [
        {
          value: "a",
          label: "a",
          daily: [{ date: "2026-08-08", input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }],
        },
        {
          value: "b",
          label: "b",
          daily: [{ date: "2026-08-08", input: 7, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }],
        },
      ],
    })
  })

  test("paginates models in descending token order inside the primary dashboard response", async () => {
    const models = Array.from({ length: 12 }, (_, index) => ({
      value: `openai/model-${String(index).padStart(2, "0")}`,
      turn_count: 1,
      input_tokens: index + 1,
    }))
    const app = UsageRoutes({
      pricing,
      identity,
      ledger: {
        usageDashboard: async () => ({
          totals: { turn_count: 12, input_tokens: 78 },
          daily: [],
          breakdown: [],
          models,
        }),
      },
    })
    const headers = { authorization: "Bearer valid" }
    const first = (await (await app.request("/?since=1&until=2&group=provider&limit=10", { headers })).json())
    expect(first.modelBreakdown.rows).toHaveLength(10)
    expect(first.modelBreakdown.rows.map((row: any) => row.value)).toEqual(
      Array.from({ length: 10 }, (_, index) => `openai/model-${String(11 - index).padStart(2, "0")}`),
    )
    expect(first.modelBreakdown.next).toBe("openai/model-02")
    const second = (await (
      await app.request("/?since=1&until=2&group=provider&limit=10&model_after=openai%2Fmodel-02", { headers })
    ).json())
    expect(second.modelBreakdown.rows.map((row: any) => row.value)).toEqual(["openai/model-01", "openai/model-00"])
    expect(second.modelBreakdown.next).toBeUndefined()
  })

  test("sorts breakdown pages by the selected usage metric", async () => {
    const app = UsageRoutes({
      pricing,
      identity,
      ledger: {
        usageDashboard: async () => ({
          totals: { turn_count: 2, input_tokens: 2_000_000, output_tokens: 1_000_000 },
          daily: [],
          models: [
            { value: "codex/gpt-5", input_tokens: 2_000_000 },
            { value: "claude/claude-sonnet-4-5", output_tokens: 1_000_000 },
          ],
          breakdown: [
            { value: "cheap", turn_count: 1, input_tokens: 2_000_000 },
            { value: "expensive", turn_count: 1, output_tokens: 1_000_000 },
          ],
          breakdownModels: [
            { group: "cheap", value: "codex/gpt-5", input_tokens: 2_000_000 },
            { group: "expensive", value: "claude/claude-sonnet-4-5", output_tokens: 1_000_000 },
          ],
        }),
      },
    })
    const headers = { authorization: "Bearer valid" }
    const tokensFirst = (await (
      await app.request("/?since=1&until=2&group=harness&metric=tokens&limit=1", { headers })
    ).json())
    expect(tokensFirst.breakdown).toMatchObject({ rows: [{ value: "cheap" }], next: "cheap" })
    const tokensSecond = (await (
      await app.request("/?since=1&until=2&group=harness&metric=tokens&limit=1&after=cheap", { headers })
    ).json())
    expect(tokensSecond.breakdown).toMatchObject({ rows: [{ value: "expensive" }] })

    const costFirst = (await (
      await app.request("/?since=1&until=2&group=harness&metric=cost&limit=1", { headers })
    ).json())
    expect(costFirst.breakdown).toMatchObject({ rows: [{ value: "expensive" }], next: "expensive" })
    expect(costFirst.breakdown.rows[0].estimatedUsd).toBeGreaterThan(tokensFirst.breakdown.rows[0].estimatedUsd)
    const costSecond = (await (
      await app.request("/?since=1&until=2&group=harness&metric=cost&limit=1&after=expensive", { headers })
    ).json())
    expect(costSecond.breakdown).toMatchObject({ rows: [{ value: "cheap" }] })

    const excluded = (await (
      await app.request("/?since=1&until=2&group=app&filter_app=claude", { headers })
    ).json())
    expect(excluded.claxedo.totals.turnCount).toBe(0)
    expect(excluded.breakdown.rows).toEqual([])
  })

  test("answers cloud facts for the verified account only, never the one a query names", async () => {
    const cloudUsageFacts = vi.fn(async () => [])
    const app = UsageRoutes({ pricing, identity, ledger: { cloudUsageFacts } })
    const headers = { authorization: "Bearer valid" }

    const response = await app.request("/cloud-facts?since=1&until=2&org_id=attacker&user_id=attacker", { headers })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ facts: [] })
    expect(cloudUsageFacts).toHaveBeenCalledWith({
      org_id: "org_from_token",
      user_id: "user_from_token",
      since: 1,
      until: 2,
      limit: 10_001,
    })

    const unsigned = await app.request("/cloud-facts?since=1&until=2")
    expect(unsigned.status).toBe(401)
    expect(await unsigned.json()).toMatchObject({ error: { code: "missing_bearer_token" } })
    expect((await app.request("/cloud-facts?since=1&until=2", { headers: { authorization: "Bearer forged" } })).status)
      .toBe(401)
    expect((await app.request(`/cloud-facts?since=0&until=${91 * 86_400_000}`, { headers })).status).toBe(400)
    expect(cloudUsageFacts).toHaveBeenCalledTimes(1)
  })

  test("refuses a cloud-facts range that holds more turns than one answer carries", async () => {
    const turn = { messageId: "m" } as TurnUsageRevision
    const app = UsageRoutes({
      pricing,
      identity,
      ledger: { cloudUsageFacts: async ({ limit }) => Array.from({ length: limit }, () => turn) },
    })
    const response = await app.request("/cloud-facts?since=1&until=2", { headers: { authorization: "Bearer valid" } })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ error: { code: "cloud_usage_range_too_large" } })
    expect((await UsageRoutes({ pricing, identity, ledger: {} })
      .request("/cloud-facts?since=1&until=2", { headers: { authorization: "Bearer valid" } })).status).toBe(503)
  })

  test("captures bounded operational evidence without tenant or usage dimensions", async () => {
    const capture = vi.fn()
    const app = UsageRoutes({
      pricing,
      identity,
      telemetry: { capture },
      ledger: {
        usageDashboard: async () => ({ totals: { turn_count: 1, input_tokens: 4 }, daily: [] }),
      },
    })

    await app.request("/?since=1&until=86400001&view=claxedo&filter_model=private-model", {
      headers: { authorization: "Bearer valid" },
    })

    expect(capture).toHaveBeenCalledWith("system", "usage.dashboard", {
      deployment: "hosted",
      rangeDays: 1,
      latencyMs: expect.any(Number),
      claxedoStatus: "available",
      quotaStatus: "unavailable",
      pricedTokens: expect.any(Number),
      unpricedTokens: expect.any(Number),
    })
    expect(JSON.stringify(capture.mock.calls)).not.toContain("private-model")
    expect(JSON.stringify(capture.mock.calls)).not.toContain("org_from_token")
  })
})

describe("local unified usage route", () => {
  const fact = {
    hostId: "h",
    sessionRef: "local:s",
    sessionId: "s",
    messageId: "m",
    revision: 1,
    observedAt: 10,
    settlement: "final",
    status: "completed",
    location: "local",
    harness: "pi",
    providerId: "anthropic",
    modelId: "m",
    tokens: { input: 10, output: 2, reasoning: null, cache: { read: 0, write: null } },
    quality: { source: "provider", knownCategories: ["input", "output", "cache_read"] },
  } as const
  const cloudFact = (input: Partial<TurnUsageRevision> & { messageId: string }): TurnUsageRevision => ({
    hostId: "workspace:ws_cloud",
    sessionRef: "workspace:ws_cloud:session:ses_cloud",
    sessionId: "ses_cloud",
    workspaceId: "ws_cloud",
    revision: 1,
    observedAt: 12,
    settlement: "final",
    status: "completed",
    location: "cloud-workspace",
    harness: "claude",
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5",
    tokens: { input: 20, output: 4, reasoning: null, cache: { read: 0, write: null } },
    quality: { source: "provider", knownCategories: ["input", "output", "cache_read"] },
    ...input,
  })
  const withCloud = (cloud: unknown) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cloud }),
  })

  test("counts the account's cloud turns in Claxedo beside this machine's turns", async () => {
    const local = { current: async () => [fact], ownedBy: async () => [fact] } as never
    const app = LocalUsageRoutes({ pricing, local, identity: async () => ({ org_id: "org", user_id: "user" }) })
    const cloud = { status: "available", facts: [cloudFact({ messageId: "msg_cloud" })] }

    const claxedo = await (await app.request("/?since=0&until=20&timezone=UTC&view=claxedo", withCloud(cloud))).json()
    expect(claxedo.claxedo.totals).toMatchObject({ turnCount: 2, input: 30 })
    expect(claxedo.claxedo.scope).toBe("cross-machine")
  })
  test("keeps the last valid quota snapshot when a refresh fails", async () => {
    const snapshot = {
      accounts: [{ harness: "codex", credentialId: "cred_1", label: "a@b.c", inUse: true, windows: [], usageAt: 5 }],
    }
    const quota = vi
      .fn()
      .mockResolvedValueOnce({ status: "available", snapshot })
      .mockRejectedValueOnce(new Error("registry offline"))
    const app = LocalUsageRoutes({
      pricing,
      local: { current: async () => [], ownedBy: async () => [] } as never,
      identity: async () => undefined,
      quota,
    })
    const request = "/?since=0&until=20&timezone=UTC&view=quota"
    expect(((await (await app.request(request)).json())).quota).toEqual({ status: "available", snapshot })
    expect(quota.mock.calls[0]?.[0]).toMatchObject({ refresh: false })
    // A failed refresh answers with the last plans plus the error. Blanking
    // every plan card because a refresh the reader was already holding an
    // answer for threw is what a reader sees as the numbers vanishing on
    // Refresh. The quota status has only two values, so the error is what
    // marks it stale.
    expect(((await (await app.request(`${request}&refresh_nonce=3`)).json())).quota).toEqual({
      status: "available",
      snapshot,
      error: "registry offline",
    })
    expect(quota.mock.calls[1]?.[0]).toMatchObject({ refresh: true })
  })

  test("a quota read that fails before any snapshot draws nothing and says why", async () => {
    const app = LocalUsageRoutes({
      pricing,
      local: { current: async () => [], ownedBy: async () => [] } as never,
      identity: async () => undefined,
      quota: async () => {
        throw new Error("registry offline")
      },
    })

    const body = (await (await app.request("/?since=0&until=20&timezone=UTC&view=quota")).json())
    expect(body.quota).toEqual({ status: "unavailable", error: "registry offline" })
  })

  test("consumes a refresh nonce once across pagination and refetches", async () => {
    const quota = vi.fn(async (_input: { refresh: boolean }) => ({ status: "unavailable" as const }))
    const app = LocalUsageRoutes({
      pricing,
      local: { current: async () => [], ownedBy: async () => [] } as never,
      identity: async () => undefined,
      quota,
    })

    const request = "/?since=0&until=20&timezone=UTC&view=quota&refresh_nonce=44"
    await app.request(request)
    await app.request(`${request}&after=next`)

    expect(quota.mock.calls.map(([input]) => input.refresh)).toEqual([true, false])
  })
  test("runs only the producers required by the selected usage view", async () => {
    const current = vi.fn(async () => [fact])
    const identity = vi.fn(async () => undefined)
    const quota = vi.fn(async () => ({ status: "unavailable" as const }))
    const app = LocalUsageRoutes({
      pricing,
      local: { current, ownedBy: async () => [] } as never,
      identity,
      quota,
    })

    await app.request("/?since=0&until=20&timezone=UTC&view=quota")
    expect(quota).toHaveBeenCalledTimes(1)
    expect(identity).not.toHaveBeenCalled()
    expect(current).not.toHaveBeenCalled()

    await app.request("/?since=0&until=20&timezone=UTC&view=claxedo")
    expect(identity).toHaveBeenCalledTimes(1)
    expect(current).toHaveBeenCalledTimes(1)
    expect(quota).toHaveBeenCalledTimes(1)
  })

  test("a cloud fetch that failed still answers this machine's usage and says the cloud part is missing", async () => {
    const app = LocalUsageRoutes({
      pricing,
      local: { current: async () => [fact], ownedBy: async () => [] } as never,
      identity: async () => ({ org_id: "org", user_id: "user" }),
    })
    const response = await app.request(
      "/?since=0&until=20&timezone=UTC&view=claxedo",
      withCloud({ status: "unavailable", error: 'operation "usage.cloudFacts" failed: 503' }),
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.claxedo).toMatchObject({
      status: "degraded",
      scope: "local",
      error: 'Cloud usage is unavailable: operation "usage.cloudFacts" failed: 503',
      totals: { turnCount: 1, input: 10 },
      locationShare: { localTokens: 12, cloudTokens: 0 },
    })
  })

  test("uses one latest revision of a turn", async () => {
    const final = {
      ...fact,
      revision: 2,
      tokens: { ...fact.tokens, input: 20 },
    } as const
    const current = vi.fn(async () => [fact, final])
    const app = LocalUsageRoutes({
      pricing,
      local: { current, ownedBy: async () => [] } as never,
      identity: async () => ({ org_id: "org", user_id: "user" }),
    })

    const body = (await (await app.request("/?since=0&until=20&timezone=UTC&view=claxedo&group=provider")).json())
    expect(current).toHaveBeenCalledWith({ since: 0, until: 20 })
    expect(body.claxedo.totals.input).toBe(20)
    expect(body.breakdown.rows).toEqual([expect.objectContaining({ value: "anthropic", turnCount: 1, input: 20 })])
    expect(body.claxedo.cost.pricedTokens + body.claxedo.cost.unpricedTokens).toBe(22)
  })
  test("filters authoritative local facts before totals and paginates the merged breakdown", async () => {
    const second = {
      ...fact,
      messageId: "m2",
      harness: "codex",
      modelId: "gpt-5",
      tokens: { ...fact.tokens, input: 30 },
    } as const
    const app = LocalUsageRoutes({
      pricing,
      local: { current: async () => [fact, second], ownedBy: async () => [fact, second] } as never,
      identity: async () => undefined,
    })
    const body = (await (
      await app.request("/?since=0&until=20&timezone=UTC&view=claxedo&group=harness&filter_harness=codex&limit=1")
    ).json())
    expect(body.claxedo.totals.input).toBe(30)
    expect(body.breakdown).toMatchObject({
      dimension: "harness",
      rows: [expect.objectContaining({ value: "codex", input: 30 })],
    })
    expect(body.filterOptions.claxedo.harness).toEqual(["codex", "pi"])

    const otherApp = await (await app.request("/?since=0&until=20&timezone=UTC&view=claxedo&group=app&filter_app=claude")).json()
    expect(otherApp.claxedo.totals.turnCount).toBe(0)
    expect(otherApp.breakdown.rows).toEqual([])
  })

  test("serves no sync endpoint", async () => {
    const app = LocalUsageRoutes({
      pricing,
      local: { current: async () => [], ownedBy: async () => [] },
      identity: async () => ({ org_id: "org", user_id: "user" }),
    })
    expect((await app.request("/sync", { method: "POST" })).status).toBe(404)
    expect(await (await app.request("/?since=0&until=20&timezone=UTC&view=claxedo")).json()).not.toHaveProperty("sync")
  })

  test("denies quota to a signed caller who is not the machine operator", async () => {
    const quota = vi.fn(async () => ({ status: "available" as const, snapshot: { accounts: [] } }))
    const app = LocalUsageRoutes({
      pricing,
      local: { current: async () => [], ownedBy: async () => [] } as never,
      identity: async () => ({ org_id: "org", user_id: "member" }),
      machineOperator: async () => false,
      quota,
    })
    const headers = { authorization: "Bearer valid" }

    const response = await app.request("/?since=0&until=20&timezone=UTC&view=quota", { headers })
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: { code: "operator_required", message: "Machine operator access is required" },
    })
    expect(quota).not.toHaveBeenCalled()
  })

  test("charts Claxedo by harness, session and workspace from the same turns its breakdown counts", async () => {
    const cloudTurn: TurnUsageRevision = {
      ...fact,
      hostId: "workspace:ws_cloud",
      sessionRef: "workspace:ws_cloud:session:ses_cloud",
      sessionId: "ses_cloud",
      workspaceId: "ws_cloud",
      messageId: "msg_cloud",
      location: "cloud-workspace",
      harness: "claude",
      tokens: { input: 20, output: 4, reasoning: null, cache: { read: 0, write: null } },
      quality: { source: "provider", knownCategories: ["input", "output", "cache_read"] },
    }
    const app = LocalUsageRoutes({
      pricing,
      local: { current: async () => [fact], ownedBy: async () => [] } as never,
      identity: async () => undefined,
    })
    for (const group of ["harness", "session", "workspace"]) {
      const body = await (await app.request(
        `/?since=0&until=20&timezone=UTC&view=claxedo&group=${group}`,
        withCloud({ status: "available", facts: [cloudTurn] }),
      )).json()
      const charted = Object.fromEntries(body.chart.series.map((series: { value: string; daily: Array<{ input: number }> }) =>
        [series.value, series.daily.reduce((sum, point) => sum + point.input, 0)]))
      const counted = Object.fromEntries(body.breakdown.rows.map((row: { value: string; input: number }) => [row.value, row.input]))
      expect(charted, group).toEqual(counted)
      expect(Object.keys(charted), group).toHaveLength(2)
    }
  })

  test("marks a row whose every turn reported no token usage, and keeps its turns counted", async () => {
    const silent = (messageId: string, input: Partial<TurnUsageRevision> = {}): TurnUsageRevision => ({
      ...fact,
      messageId,
      harness: "connection:cursor-acp",
      providerId: "cursor",
      settlement: "unavailable",
      tokens: { input: null, output: null, reasoning: null, cache: { read: null, write: null } },
      quality: { source: "lifecycle", knownCategories: [] },
      ...input,
    })
    const facts: TurnUsageRevision[] = [
      silent("msg_silent_1"),
      // Settled with a usage observation that named no category: still nothing measured.
      silent("msg_silent_2", { settlement: "final", quality: { source: "provider", knownCategories: [] } }),
      // Still running: it may yet report, so it does not make its row silent.
      silent("msg_running", { harness: "claude", providerId: "anthropic", settlement: "provisional", status: "running" }),
      { ...fact, messageId: "msg_measured", harness: "claude", modelId: "claude-sonnet-4-5", tokens: { ...fact.tokens }, quality: { source: "provider", knownCategories: ["input", "output", "cache_read"] } },
    ]
    const app = LocalUsageRoutes({
      pricing,
      local: { current: async () => facts, ownedBy: async () => [] },
      identity: async () => undefined,
    })
    const body = await (await app.request("/?since=0&until=20&timezone=UTC&view=claxedo&group=harness")).json()
    expect(body.claxedo.totals).toMatchObject({ turnCount: 4, unavailableTurnCount: 2 })
    expect(body.breakdown.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: "connection:cursor-acp", turnCount: 2, input: 0, status: "unavailable" }),
      expect.objectContaining({ value: "claude", turnCount: 2, unavailableTurnCount: 0, status: "partial" }),
    ]))
  })

  test("a signed member who is not the operator reads only the turns their account produced", async () => {
    const current = vi.fn(async () => [fact])
    const ownedBy = vi.fn(async () => [])
    const app = LocalUsageRoutes({
      pricing,
      local: { current, ownedBy } as never,
      identity: async () => ({ org_id: "org", user_id: "member" }),
      machineOperator: async () => false,
    })

    const response = await app.request("/?since=0&until=20&timezone=UTC&view=claxedo", {
      headers: { authorization: "Bearer valid" },
    })
    expect(response.status).toBe(200)
    expect((await response.json()).claxedo.totals.turnCount).toBe(0)
    expect(ownedBy).toHaveBeenCalledWith({ org_id: "org", user_id: "member" }, { since: 0, until: 20 })
    expect(current).not.toHaveBeenCalled()
  })

  test("preserves control-plane auth errors on the local read", async () => {
    const app = LocalUsageRoutes({
      pricing,
      local: { current: async () => [], ownedBy: async () => [] } as never,
      identity: async () => {
        throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Bearer token is invalid")
      },
    })
    for (const request of [
      app.request("/?since=0&until=20&timezone=UTC"),
      app.request("/?since=0&until=20&timezone=UTC", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cloud: { status: "available", facts: [] } }),
      }),
    ]) {
      const response = await request
      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({
        error: { code: "invalid_bearer_token", message: "Bearer token is invalid", retryable: false },
      })
    }
  })
})

describe("local usage route with the account's cloud turns", () => {
  const local: TurnUsageRevision = {
    hostId: "local_machine",
    sessionRef: "local:/work:session:ses_local",
    sessionId: "ses_local",
    workspaceId: "wrk_local",
    messageId: "msg_local",
    revision: 1,
    observedAt: 10,
    settlement: "final",
    status: "completed",
    location: "local",
    harness: "codex",
    providerId: "openai",
    modelId: "gpt-5",
    tokens: { input: 1_000_000, output: 0, reasoning: null, cache: { read: 0, write: null } },
    quality: { source: "provider", knownCategories: ["input", "output", "cache_read"] },
  }
  const cloud = (input: Partial<TurnUsageRevision> & { messageId: string }): TurnUsageRevision => ({
    hostId: "workspace:ws_cloud",
    sessionRef: "workspace:ws_cloud:session:ses_cloud",
    sessionId: "ses_cloud",
    workspaceId: "ws_cloud",
    revision: 1,
    observedAt: 12,
    settlement: "final",
    status: "completed",
    location: "cloud-workspace",
    harness: "claude",
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5",
    tokens: { input: 1_000_000, output: 1_000_000, reasoning: 0, cache: { read: 0, write: 0 } },
    quality: { source: "provider", knownCategories: ["input", "output", "reasoning", "cache_read", "cache_write"] },
    ...input,
  })
  const app = (machineOperator?: () => boolean) => LocalUsageRoutes({
    pricing,
    local: {
      current: async ({ since = 0, until = Infinity } = {}) =>
        [local].filter((fact) => fact.observedAt >= since && fact.observedAt <= until),
      ownedBy: async () => [],
    },
    identity: async () => undefined,
    ...(machineOperator ? { machineOperator } : {}),
  })
  const post = (routes: ReturnType<typeof app>, query: string, body: unknown) =>
    routes.request(`/?timezone=UTC&${query.includes("since=") ? "" : "since=0&until=20&"}${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })

  test("merges them into one Claxedo projection: totals, cost, location share, breakdowns and filters", async () => {
    const routes = app()
    const facts = [
      cloud({ messageId: "msg_c1", revision: 1, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }),
      cloud({ messageId: "msg_c1", revision: 2 }),
    ]
    const response = await post(routes, "view=claxedo&group=location", { cloud: { status: "available", facts } })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.claxedo).toMatchObject({
      status: "available",
      scope: "cross-machine",
      totals: { turnCount: 2, input: 2_000_000, output: 1_000_000 },
      locationShare: { localTokens: 1_000_000, cloudTokens: 2_000_000 },
    })
    const localUsd = (await pricing({
      source: "openai",
      model: "gpt-5",
      tokens: { input: 1_000_000, output: 0, reasoning: null, cacheRead: 0, cacheWrite: null, cacheWrite1h: null },
    })).estimatedUsd
    // Sonnet 4.5: $3 input and $15 output per MTok.
    expect(body.claxedo.cost.estimatedUsd).toBeCloseTo(localUsd + 18, 10)
    expect(body.claxedo.cost.unpricedTokens).toBe(0)
    expect(body.breakdown.rows).toEqual([
      expect.objectContaining({ value: "cloud", turnCount: 1, input: 1_000_000, output: 1_000_000, status: "final" }),
      expect.objectContaining({ value: "local", turnCount: 1, input: 1_000_000 }),
    ])
    expect(body.breakdown.rows[0].estimatedUsd).toBeCloseTo(18, 10)
    expect(body.modelBreakdown.rows.find((row: { value: string }) => row.value === "anthropic/claude-sonnet-4-5").estimatedUsd)
      .toBeCloseTo(18, 10)
    expect(body.filterOptions.claxedo).toMatchObject({
      location: ["cloud", "local"],
      harness: ["claude", "codex"],
      workspace: ["wrk_local", "ws_cloud"],
    })

    const onlyCloud = await (await post(routes, "view=claxedo&filter_location=cloud", {
      cloud: { status: "available", facts },
    })).json()
    expect(onlyCloud.claxedo.totals).toMatchObject({ turnCount: 1, input: 1_000_000 })
    expect(onlyCloud.claxedo.cost.estimatedUsd).toBeCloseTo(18, 10)

    const withoutCloud = await (await routes.request("/?since=0&until=20&timezone=UTC&view=claxedo")).json()
    expect(withoutCloud.claxedo).toMatchObject({ scope: "local", status: "available", totals: { turnCount: 1 } })
  })

  test("drops cloud turns outside the requested range", async () => {
    const body = await (await post(app(), "since=11&until=20&view=claxedo", {
      cloud: {
        status: "available",
        facts: [
          cloud({ messageId: "msg_early", observedAt: 10 }),
          cloud({ messageId: "msg_in", observedAt: 12 }),
          cloud({ messageId: "msg_late", observedAt: 21 }),
        ],
      },
    })).json()
    expect(body.claxedo.totals.turnCount).toBe(1)
    expect(body.claxedo.cost.pricedTokens).toBe(2_000_000)
  })

  test.each([
    ["a local turn", cloud({ messageId: "m", location: "local" })],
    ["another host's filing", cloud({ messageId: "m", hostId: "local_machine" })],
    ["a session filed under another workspace", cloud({ messageId: "m", sessionRef: "workspace:ws_other:session:ses_cloud" })],
    ["no workspace", { ...cloud({ messageId: "m" }), workspaceId: undefined }],
    ["a field the revision does not carry", { ...cloud({ messageId: "m" }), prompt: "secret" }],
    ["negative tokens", cloud({ messageId: "m", tokens: { input: -1, output: 0, reasoning: null, cache: { read: 0, write: 0 } } })],
    ["a revision below one", cloud({ messageId: "m", revision: 0 })],
  ])("leaves out %s posing as a cloud turn, counts the rest and says how many it left out", async (_name, fact) => {
    const response = await post(app(), "view=claxedo", {
      cloud: { status: "available", facts: [fact, cloud({ messageId: "msg_readable" })] },
    })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.claxedo).toMatchObject({
      status: "degraded",
      error: "1 cloud turn could not be read and is not counted.",
      scope: "cross-machine",
      totals: { turnCount: 2, input: 2_000_000 },
    })
  })

  test("a cloud read that failed without a reason still answers this machine's usage", async () => {
    const response = await post(app(), "view=claxedo", { cloud: { status: "unavailable", error: "" } })
    expect(response.status).toBe(200)
    expect((await response.json()).claxedo).toMatchObject({
      status: "degraded",
      error: "Cloud usage is unavailable.",
      scope: "local",
      totals: { turnCount: 1 },
    })
  })

  test("refuses a malformed cloud body and more cloud turns than one answer carries", async () => {
    for (const body of [{}, { cloud: { status: "available" } }, { cloud: { status: "unavailable" } }, { cloud: [] }]) {
      const response = await post(app(), "view=claxedo", body)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: "invalid_cloud_usage" } })
    }
    const tooMany = Array.from({ length: 10_001 }, (_, index) => cloud({ messageId: `m${index}` }))
    const response = await post(app(), "view=claxedo", { cloud: { status: "available", facts: tooMany } })
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ error: { code: "cloud_usage_too_large" } })

    const oversized = await app().request("/?since=0&until=20&timezone=UTC", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cloud: { status: "unavailable", error: "x".repeat(16 * 1024 * 1024) } }),
    })
    expect(oversized.status).toBe(413)
  })

  test("only the machine's operator may bring cloud turns into this machine's view", async () => {
    const response = await post(app(() => false), "view=claxedo", {
      cloud: { status: "available", facts: [cloud({ messageId: "m" })] },
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: { code: "operator_required", message: "Machine operator access is required" },
    })
  })
})
