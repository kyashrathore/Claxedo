import { describe, expect, test, vi } from "vitest"
import { ControlPlaneAuthError, type ClerkVerifier } from "@claxedo/server-core/platform/auth/auth"
import { UsageRoutes } from "@claxedo/server-core/usage/routes"
import { LocalUsageRoutes } from "@claxedo/local-server/self-hosted-execution"

const authConfig = { enabled: true as const, issuer: "https://auth.test", jwksUrl: "custom:test" }
const verifier: ClerkVerifier = async (token) => ({
  mode: "signed",
  token,
  user: { subject: "user_from_token", orgId: "org_from_token", tokenIdentifier: "token_1", issuer: authConfig.issuer },
})

describe("usage routes", () => {
  test("derives tenant from verified auth and never trusts query identity", async () => {
    const usageDashboard = vi.fn(async () => ({ totals: { turn_count: 1 }, daily: [], breakdown: [] }))
    const usageBreakdown = vi.fn(async () => ({ rows: [], next: undefined }))
    const app = UsageRoutes({
      authConfig,
      verifier,
      ledger: { recordLlmTurn: async () => ({ activated: false }), usageDashboard, usageBreakdown },
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
    expect(usageBreakdown).toHaveBeenCalledWith(
      expect.objectContaining({ org_id: "org_from_token", user_id: "user_from_token", dimension: "model" }),
    )
  })

  test("rejects unsigned, invalid ranges, and invalid group dimensions", async () => {
    const ledger = { recordLlmTurn: async () => ({ activated: false }), usageDashboard: async () => ({}) }
    const app = UsageRoutes({ authConfig, verifier, ledger })
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

  test("returns hosted quota capability without running usage projection or pricing", async () => {
    const usageDashboard = vi.fn(async () => {
      throw new Error("must not run")
    })
    const usageBreakdown = vi.fn(async () => {
      throw new Error("must not run")
    })
    const app = UsageRoutes({
      authConfig,
      verifier,
      ledger: { recordLlmTurn: async () => ({ activated: false }), usageDashboard, usageBreakdown },
    })

    const response = await app.request("/?since=1&until=2&view=quota", {
      headers: { authorization: "Bearer valid" },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      quota: { status: "unavailable" },
      claxedo: { status: "unavailable" },
      externalLocal: { status: "unavailable" },
    })
    expect(usageDashboard).not.toHaveBeenCalled()
    expect(usageBreakdown).not.toHaveBeenCalled()
  })

  test("accepts a 90-calendar-day range containing a DST fall-back hour", async () => {
    const app = UsageRoutes({
      authConfig,
      verifier,
      ledger: {
        recordLlmTurn: async () => ({ activated: false }),
        usageDashboard: async () => ({ totals: {}, daily: [] }),
      },
    })
    const response = await app.request(`/?since=0&until=${90 * 86_400_000 + 3_600_000}&timezone=America/New_York`, {
      headers: { authorization: "Bearer valid" },
    })
    expect(response.status).toBe(200)
  })

  test("paginates every model row for cost and returns Claxedo in the app breakdown", async () => {
    const usageBreakdown = vi.fn(async (input: { after?: string }) =>
      input.after
        ? { rows: [{ value: "openai/gpt-5", input_tokens: 7 }], next: undefined }
        : { rows: [{ value: "anthropic/claude-sonnet-5", input_tokens: 5 }], next: "page-2" },
    )
    const app = UsageRoutes({
      authConfig,
      verifier,
      ledger: {
        recordLlmTurn: async () => ({ activated: false }),
        usageDashboard: async () => ({ totals: { turn_count: 2, input_tokens: 12 }, daily: [] }),
        usageBreakdown,
      },
    })

    const response = await app.request("/?since=1&until=2&group=app", { headers: { authorization: "Bearer valid" } })
    const body = (await response.json()) as any
    expect(body.breakdown).toEqual({
      dimension: "app",
      rows: [expect.objectContaining({ value: "Claxedo", turnCount: 2, input: 12 })],
    })
    expect(usageBreakdown).toHaveBeenNthCalledWith(2, expect.objectContaining({ after: "page-2" }))
    expect(body.claxedo.cost.pricedTokens + body.claxedo.cost.unpricedTokens).toBe(12)
  })

  test("returns a canonical priced breakdown page from the exact dashboard projection", async () => {
    const app = UsageRoutes({
      authConfig,
      verifier,
      ledger: {
        recordLlmTurn: async () => ({ activated: false }),
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
    ).json()) as any
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
      authConfig,
      verifier,
      ledger: {
        recordLlmTurn: async () => ({ activated: false }),
        usageDashboard: async () => ({
          totals: { turn_count: 12, input_tokens: 78 },
          daily: [],
          breakdown: [],
          models,
        }),
      },
    })
    const headers = { authorization: "Bearer valid" }
    const first = (await (await app.request("/?since=1&until=2&group=provider&limit=10", { headers })).json()) as any
    expect(first.modelBreakdown.rows).toHaveLength(10)
    expect(first.modelBreakdown.rows.map((row: any) => row.value)).toEqual(
      Array.from({ length: 10 }, (_, index) => `openai/model-${String(11 - index).padStart(2, "0")}`),
    )
    expect(first.modelBreakdown.next).toBe("openai/model-02")
    const second = (await (
      await app.request("/?since=1&until=2&group=provider&limit=10&model_after=openai%2Fmodel-02", { headers })
    ).json()) as any
    expect(second.modelBreakdown.rows.map((row: any) => row.value)).toEqual(["openai/model-01", "openai/model-00"])
    expect(second.modelBreakdown.next).toBeUndefined()
  })

  test("sorts breakdown pages by the selected usage metric", async () => {
    const app = UsageRoutes({
      authConfig,
      verifier,
      ledger: {
        recordLlmTurn: async () => ({ activated: false }),
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
    ).json()) as any
    expect(tokensFirst.breakdown).toMatchObject({ rows: [{ value: "cheap" }], next: "cheap" })
    const tokensSecond = (await (
      await app.request("/?since=1&until=2&group=harness&metric=tokens&limit=1&after=cheap", { headers })
    ).json()) as any
    expect(tokensSecond.breakdown).toMatchObject({ rows: [{ value: "expensive" }] })

    const costFirst = (await (
      await app.request("/?since=1&until=2&group=harness&metric=cost&limit=1", { headers })
    ).json()) as any
    expect(costFirst.breakdown).toMatchObject({ rows: [{ value: "expensive" }], next: "expensive" })
    expect(costFirst.breakdown.rows[0].estimatedUsd).toBeGreaterThan(tokensFirst.breakdown.rows[0].estimatedUsd)
    const costSecond = (await (
      await app.request("/?since=1&until=2&group=harness&metric=cost&limit=1&after=expensive", { headers })
    ).json()) as any
    expect(costSecond.breakdown).toMatchObject({ rows: [{ value: "cheap" }] })

    const excluded = (await (
      await app.request("/?since=1&until=2&group=app&filter_app=claude", { headers })
    ).json()) as any
    expect(excluded.claxedo.totals.turnCount).toBe(0)
    expect(excluded.breakdown.rows).toEqual([])
  })

  test("captures bounded operational evidence without tenant or usage dimensions", async () => {
    const capture = vi.fn()
    const app = UsageRoutes({
      authConfig,
      verifier,
      telemetry: { capture },
      ledger: {
        recordLlmTurn: async () => ({ activated: false }),
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
      externalStatus: "unavailable",
      quotaStatus: "unavailable",
      pricedTokens: expect.any(Number),
      unpricedTokens: expect.any(Number),
    })
    expect(JSON.stringify(capture.mock.calls)).not.toContain("private-model")
    expect(JSON.stringify(capture.mock.calls)).not.toContain("org_from_token")
  })
})

describe("local unified usage route", () => {
  const outbox = (result: { attempted: number; delivered: number; conflicts: number; pending: number }) => ({
    flush: async () => result,
    clearIdentity: async () => result,
  })
  const fact = {
    hostId: "h",
    sessionRef: "central:s",
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

  test("sorts Total local providers by tokens or cost from the authoritative history", async () => {
    const rows = [
      {
        app: "codex",
        provider: "codex",
        model: "gpt-5",
        bucketStart: 10,
        nativeSessionId: "cheap",
        turnCount: 1,
        tokens: { input: 2_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        app: "claude",
        provider: "claude",
        model: "claude-sonnet-4-5",
        bucketStart: 10,
        nativeSessionId: "expensive",
        turnCount: 1,
        tokens: { input: 0, output: 1_000_000, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ]
    const app = LocalUsageRoutes({
      local: { current: async () => [], pendingOutbox: async () => [] } as never,
      identity: async () => undefined,
      outbox: outbox({ attempted: 0, delivered: 0, conflicts: 0, pending: 0 }),
      history: async () => ({
        rows,
        totalRows: rows,
        coverage: [],
        classifiedClaxedo: 0,
        unclassified: 0,
      }),
    })

    const tokens = (await (
      await app.request("/?since=0&until=20&timezone=UTC&view=total&group=provider&metric=tokens")
    ).json()) as any
    expect(tokens.breakdown.rows.map((row: any) => row.value)).toEqual(["codex", "claude"])

    const cost = (await (
      await app.request("/?since=0&until=20&timezone=UTC&view=total&group=provider&metric=cost")
    ).json()) as any
    expect(cost.breakdown.rows.map((row: any) => row.value)).toEqual(["claude", "codex"])
    expect(cost.breakdown.rows[0].estimatedUsd).toBeGreaterThan(cost.breakdown.rows[1].estimatedUsd)
    expect(
      (await app.request("/?since=0&until=20&timezone=UTC&view=total&metric=turns")).status,
    ).toBe(400)
  })

  test("keeps cross-machine Claxedo usage separate from authoritative Total local history", async () => {
    const local = { current: async () => [fact], pendingOutbox: async () => [fact] } as never
    const app = LocalUsageRoutes({
      local,
      identity: async () => ({ org_id: "org", user_id: "user" }),
      outbox: outbox({ attempted: 0, delivered: 0, conflicts: 0, pending: 1 }),
      central: {
        recordLlmTurn: async () => ({ activated: false }),
        usageDashboard: async () => ({ totals: { turn_count: 1, input_tokens: 20 }, daily: [] }),
      },
      history: async () => {
        const direct = {
          app: "claude",
          provider: "anthropic",
          model: "m",
          bucketStart: 10,
          nativeSessionId: "direct",
          turnCount: 1,
          tokens: { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        }
        const throughClaxedo = {
          app: "pi",
          provider: "anthropic",
          model: "m",
          bucketStart: 10,
          nativeSessionId: "native-claxedo",
          turnCount: 1,
          tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        }
        return {
          rows: [direct],
          totalRows: [direct, throughClaxedo],
          coverage: [{ source: "claude", status: "available" }],
          classifiedClaxedo: 1,
          unclassified: 0,
        }
      },
    })
    const response = await app.request("/?since=0&until=20&timezone=UTC&view=total")
    const body = (await response.json()) as any
    expect(body.claxedo.totals.input).toBe(30)
    expect(body.total.totals.input).toBe(15)
    expect(body.claxedo.scope).toBe("cross-machine")
  })

  test("builds Total local usage from provider history even when attribution is quarantined", async () => {
    const row = {
      app: "codex",
      provider: "openai",
      model: "gpt-5.6-sol",
      bucketStart: 10,
      nativeSessionId: "historical-codex",
      turnCount: 123,
      tokens: { input: 50, output: 5, reasoning: 2, cacheRead: 100, cacheWrite: 0 },
    }
    const app = LocalUsageRoutes({
      local: { current: async () => [], pendingOutbox: async () => [] } as never,
      identity: async () => undefined,
      outbox: outbox({ attempted: 0, delivered: 0, conflicts: 0, pending: 0 }),
      history: async () => ({
        rows: [],
        totalRows: [row],
        coverage: [{ source: "codex", status: "available" }],
        classifiedClaxedo: 0,
        unclassified: 1,
      }),
    })

    const response = await app.request("/?since=0&until=20&timezone=UTC&view=total&group=provider")
    const body = (await response.json()) as any
    expect(body.externalLocal.totals.input).toBe(0)
    expect(body.total.totals).toMatchObject({ turnCount: 123, input: 50, output: 5, reasoning: 2, cacheRead: 100 })
    expect(body.breakdown.rows).toEqual([
      expect.objectContaining({ value: "openai", turnCount: 123, input: 50, output: 5, reasoning: 2, cacheRead: 100 }),
    ])
    expect(body.chart.series).toEqual([
      expect.objectContaining({ value: "openai", daily: [expect.objectContaining({ input: 50 })] }),
    ])
    expect(body.externalLocal.unclassified).toBe(1)
  })

  test("anonymous requests stay local and source failures do not zero Claxedo", async () => {
    const app = LocalUsageRoutes({
      local: { current: async () => [fact], pendingOutbox: async () => [fact] } as never,
      identity: async () => undefined,
      outbox: outbox({ attempted: 0, delivered: 0, conflicts: 0, pending: 1 }),
      history: async () => {
        throw new Error("scanner unavailable")
      },
    })
    const body = (await (await app.request("/?since=0&until=20&timezone=UTC&view=total")).json()) as any
    expect(body.claxedo.totals.input).toBe(10)
    expect(body.externalLocal.status).toBe("degraded")
    expect(body.sync.pending).toBe(1)
  })

  test("retains the last valid local-history snapshot when refresh fails", async () => {
    const history = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            app: "codex",
            provider: "openai",
            model: "gpt-5.6-sol",
            bucketStart: 10,
            nativeSessionId: "direct",
            turnCount: 1,
            tokens: { input: 5, output: 2, reasoning: 1, cacheRead: 7, cacheWrite: null },
          },
        ],
        totalRows: [
          {
            app: "codex",
            provider: "openai",
            model: "gpt-5.6-sol",
            bucketStart: 10,
            nativeSessionId: "direct",
            turnCount: 1,
            tokens: { input: 5, output: 2, reasoning: 1, cacheRead: 7, cacheWrite: null },
          },
        ],
        coverage: [{ source: "codex", status: "available" }],
        classifiedClaxedo: 0,
        unclassified: 0,
      })
      .mockRejectedValueOnce(new Error("scanner offline"))
    const app = LocalUsageRoutes({
      local: { current: async () => [], pendingOutbox: async () => [] } as never,
      identity: async () => undefined,
      outbox: outbox({ attempted: 0, delivered: 0, conflicts: 0, pending: 0 }),
      history,
    })
    const first = (await (await app.request("/?since=0&until=20&timezone=UTC&view=total&group=app")).json()) as any
    expect(first.total.totals).toMatchObject({ input: 5, output: 2, reasoning: 1, cacheRead: 7 })
    const stale = (await (
      await app.request("/?since=0&until=20&timezone=UTC&view=total&group=app&refresh_nonce=1")
    ).json()) as any
    expect(stale.externalLocal).toMatchObject({
      status: "degraded",
      error: "scanner offline",
      totals: { input: 5, output: 2, reasoning: 1, cacheRead: 7 },
    })
    expect(stale.breakdown.rows.find((row: any) => row.value === "codex")).toMatchObject({
      status: "partial",
      unknownCategories: 1,
    })
  })

  test("never reuses a failed history snapshot for a shifted range", async () => {
    const history = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            app: "codex",
            provider: "openai",
            model: "gpt-5.6-sol",
            bucketStart: 10,
            nativeSessionId: "direct",
            turnCount: 1,
            tokens: { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
        totalRows: [
          {
            app: "codex",
            provider: "openai",
            model: "gpt-5.6-sol",
            bucketStart: 10,
            nativeSessionId: "direct",
            turnCount: 1,
            tokens: { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
        coverage: [{ source: "codex", status: "available" }],
        classifiedClaxedo: 0,
        unclassified: 0,
      })
      .mockRejectedValueOnce(new Error("scanner offline"))
    const app = LocalUsageRoutes({
      local: { current: async () => [], pendingOutbox: async () => [] } as never,
      identity: async () => undefined,
      outbox: outbox({ attempted: 0, delivered: 0, conflicts: 0, pending: 0 }),
      history,
    })
    await app.request("/?since=0&until=20&timezone=UTC&view=total")
    const shifted = (await (
      await app.request("/?since=20&until=40&timezone=UTC&view=total&refresh_nonce=2")
    ).json()) as any
    expect(shifted.externalLocal).toMatchObject({ status: "degraded", totals: { input: 0 } })
    expect(shifted.filterOptions.total.app ?? []).not.toContain("codex")
  })

  test("keeps the last valid quota snapshot when a refresh probe fails", async () => {
    const snapshot = { providers: [{ provider: "openai", windows: [{ label: "weekly", usedPercent: 20 }] }] }
    const quota = vi.fn().mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error("quota offline"))
    const app = LocalUsageRoutes({
      local: { current: async () => [], pendingOutbox: async () => [] } as never,
      identity: async () => undefined,
      outbox: outbox({ attempted: 0, delivered: 0, conflicts: 0, pending: 0 }),
      quota,
    })
    const request = "/?since=0&until=20&timezone=UTC&view=quota"
    expect(((await (await app.request(request)).json()) as any).quota).toEqual({ status: "available", snapshot })
    expect(((await (await app.request(`${request}&refresh_nonce=3`)).json()) as any).quota).toEqual({
      status: "degraded",
      snapshot,
      error: "quota offline",
    })
  })

  test("consumes a refresh nonce once across pagination and refetches", async () => {
    const history = vi.fn(async ({ refresh }: { refresh: boolean }) => ({
      rows: [],
      totalRows: [],
      coverage: [],
      classifiedClaxedo: 0,
      unclassified: 0,
      refresh,
    }))
    const app = LocalUsageRoutes({
      local: { current: async () => [], pendingOutbox: async () => [] } as never,
      identity: async () => undefined,
      outbox: outbox({ attempted: 0, delivered: 0, conflicts: 0, pending: 0 }),
      history,
    })

    const request = "/?since=0&until=20&timezone=UTC&view=total&group=provider&refresh_nonce=44"
    await app.request(request)
    await app.request(`${request}&after=next`)

    expect(history).toHaveBeenNthCalledWith(1, { since: 0, until: 20, refresh: true })
    expect(history).toHaveBeenNthCalledWith(2, { since: 0, until: 20, refresh: false })
  })

  test("runs only the producers required by the selected usage view", async () => {
    const current = vi.fn(async () => [fact])
    const pendingOutbox = vi.fn(async () => [fact])
    const identity = vi.fn(async () => undefined)
    const history = vi.fn(async () => ({
      rows: [],
      totalRows: [],
      coverage: [],
      classifiedClaxedo: 0,
      unclassified: 0,
    }))
    const quota = vi.fn(async () => ({ providers: [] }))
    const app = LocalUsageRoutes({
      local: { current, pendingOutbox } as never,
      identity,
      outbox: outbox({ attempted: 0, delivered: 0, conflicts: 0, pending: 0 }),
      history,
      quota,
    })

    await app.request("/?since=0&until=20&timezone=UTC&view=quota")
    expect(quota).toHaveBeenCalledTimes(1)
    expect(identity).not.toHaveBeenCalled()
    expect(current).not.toHaveBeenCalled()
    expect(history).not.toHaveBeenCalled()

    await app.request("/?since=0&until=20&timezone=UTC&view=claxedo")
    expect(identity).toHaveBeenCalledTimes(1)
    expect(current).toHaveBeenCalledTimes(1)
    expect(history).not.toHaveBeenCalled()
    expect(quota).toHaveBeenCalledTimes(1)

    await app.request("/?since=0&until=20&timezone=UTC&view=total")
    expect(identity).toHaveBeenCalledTimes(2)
    expect(current).toHaveBeenCalledTimes(2)
    expect(history).toHaveBeenCalledTimes(1)
    expect(quota).toHaveBeenCalledTimes(1)
  })

  test("keeps the last tenant-scoped central snapshot when refresh fails", async () => {
    const usageDashboard = vi
      .fn()
      .mockResolvedValueOnce({ totals: { turn_count: 1, input_tokens: 25 }, daily: [], models: [], locations: [] })
      .mockRejectedValueOnce(new Error("central offline"))
    const app = LocalUsageRoutes({
      local: { current: async () => [], pendingOutbox: async () => [] } as never,
      identity: async () => ({ org_id: "org", user_id: "user" }),
      outbox: outbox({ attempted: 0, delivered: 0, conflicts: 0, pending: 0 }),
      central: { recordLlmTurn: async () => ({ activated: false }), usageDashboard },
    })
    const request = "/?since=0&until=20&timezone=UTC&view=claxedo"
    expect(((await (await app.request(request)).json()) as any).claxedo.totals.input).toBe(25)
    const stale = (await (await app.request(request)).json()) as any
    expect(stale.claxedo).toMatchObject({ status: "stale", error: "central offline", totals: { input: 25 } })
  })

  test("uses one latest pending revision and attributes total usage to its canonical provider", async () => {
    const final = {
      ...fact,
      revision: 2,
      tokens: { ...fact.tokens, input: 20 },
    } as const
    const pendingOutbox = vi.fn(async () => [fact, final])
    const app = LocalUsageRoutes({
      local: { current: async () => [final], pendingOutbox } as never,
      identity: async () => ({ org_id: "org", user_id: "user" }),
      outbox: outbox({ attempted: 0, delivered: 0, conflicts: 0, pending: 2 }),
      central: {
        recordLlmTurn: async () => ({ activated: false }),
        usageDashboard: async () => ({ totals: { turn_count: 0 }, daily: [] }),
      },
      history: async () => ({
        rows: [
          {
            app: "claude",
            provider: "anthropic",
            model: "m",
            bucketStart: 10,
            nativeSessionId: "direct",
            turnCount: 1,
            tokens: { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
        totalRows: [
          {
            app: "claude",
            provider: "anthropic",
            model: "m",
            bucketStart: 10,
            nativeSessionId: "direct",
            turnCount: 1,
            tokens: { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          },
          {
            app: "pi",
            provider: "anthropic",
            model: "m",
            bucketStart: 10,
            nativeSessionId: "claxedo-pi",
            turnCount: 1,
            tokens: { input: 20, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
        coverage: [],
        classifiedClaxedo: 0,
        unclassified: 0,
      }),
    })

    const body = (await (await app.request("/?since=0&until=20&timezone=UTC&view=total&group=app")).json()) as any
    expect(pendingOutbox).toHaveBeenCalledWith({ since: 0, until: 20, all: true })
    expect(body.claxedo.totals.input).toBe(20)
    expect(body.breakdown.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "pi", turnCount: 1, input: 20 }),
        expect.objectContaining({ value: "claude", turnCount: 1, input: 5 }),
      ]),
    )
    expect(body.chart.dimension).toBe("app")
    expect(body.chart.series).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: "pi",
          daily: [expect.objectContaining({ date: "1970-01-01", input: 20, output: 2 })],
        }),
        expect.objectContaining({
          value: "claude",
          daily: [expect.objectContaining({ date: "1970-01-01", input: 5, output: 0 })],
        }),
      ]),
    )
    expect(body.claxedo.cost.pricedTokens + body.claxedo.cost.unpricedTokens).toBe(22)

    const provider = (await (
      await app.request("/?since=0&until=20&timezone=UTC&view=total&group=provider")
    ).json()) as any
    expect(provider.breakdown).toMatchObject({
      dimension: "provider",
      rows: [expect.objectContaining({ value: "anthropic", turnCount: 2, input: 25 })],
    })
    expect(provider.breakdown.rows.some((row: { value: string }) => row.value === "Claxedo")).toBe(false)
    expect(provider.chart).toMatchObject({
      dimension: "provider",
      series: [expect.objectContaining({ value: "anthropic" })],
    })

    const model = (await (await app.request("/?since=0&until=20&timezone=UTC&view=total&group=model")).json()) as any
    expect(model.breakdown.rows).toEqual([expect.objectContaining({ value: "anthropic/m", label: "m", input: 25 })])
  })

  test("replaces an older central fact with its newer pending local revision", async () => {
    const pending = { ...fact, revision: 2, tokens: { ...fact.tokens, input: 20 } } as const
    const app = LocalUsageRoutes({
      local: { current: async () => [pending], pendingOutbox: async () => [pending] } as never,
      identity: async () => ({ org_id: "org", user_id: "user" }),
      outbox: outbox({ attempted: 1, delivered: 0, conflicts: 0, pending: 1 }),
      central: {
        recordLlmTurn: async () => ({ activated: false }),
        usageDashboard: async () => ({
          totals: { turn_count: 1, input_tokens: 10 },
          daily: [],
          models: [],
          locations: [],
          breakdown: [],
          dailyBreakdown: [],
          breakdownModels: [],
          filters: {},
          facts: [
            {
              host_id: fact.hostId,
              session_ref: fact.sessionRef,
              session_id: fact.sessionId,
              message_id: fact.messageId,
              revision: fact.revision,
              observed_at: fact.observedAt,
              settlement: fact.settlement,
              status: fact.status,
              location: fact.location,
              harness: fact.harness,
              provider_id: fact.providerId,
              model_id: fact.modelId,
              input_tokens: fact.tokens.input,
              output_tokens: fact.tokens.output,
              reasoning_tokens: fact.tokens.reasoning,
              cache_read_tokens: fact.tokens.cache.read,
              cache_write_tokens: fact.tokens.cache.write,
            },
          ],
        }),
      },
    })

    const body = (await (await app.request("/?since=0&until=20&timezone=UTC&view=claxedo&group=model")).json()) as any
    expect(body.claxedo.totals).toMatchObject({ turnCount: 1, input: 20, output: 2 })
    expect(body.breakdown.rows).toEqual([
      expect.objectContaining({ value: "anthropic/m", turnCount: 1, input: 20, output: 2 }),
    ])
    expect(body.chart.series).toEqual([
      expect.objectContaining({ value: "anthropic/m", daily: [expect.objectContaining({ input: 20, output: 2 })] }),
    ])
  })

  test("does not add an acknowledged fact when local delivery bookkeeping leaves it pending", async () => {
    const app = LocalUsageRoutes({
      local: { current: async () => [fact], pendingOutbox: async () => [fact] } as never,
      identity: async () => ({ org_id: "org", user_id: "user" }),
      outbox: {
        clearIdentity: async () => ({ attempted: 0, delivered: 0, conflicts: 0, pending: 1 }),
        flush: async () => ({
          attempted: 1,
          delivered: 0,
          conflicts: 0,
          pending: 1,
          acknowledged: [
            { hostId: fact.hostId, sessionRef: fact.sessionRef, messageId: fact.messageId, revision: fact.revision },
          ],
        }),
      },
      central: {
        recordLlmTurn: async () => ({ activated: false }),
        usageDashboard: async () => ({
          totals: { turn_count: 1, input_tokens: 10, output_tokens: 2, input_known_count: 1, output_known_count: 1 },
          daily: [],
          models: [{ value: "anthropic/m", input_tokens: 10, output_tokens: 2 }],
          breakdown: [],
        }),
      },
    })
    const body = (await (await app.request("/?since=0&until=20&timezone=UTC")).json()) as any
    expect(body.claxedo.totals.input).toBe(10)
    expect(body.sync).toEqual({ attempted: 1, delivered: 0, conflicts: 0, pending: 1 })
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
      local: { current: async () => [fact, second], pendingOutbox: async () => [fact, second] } as never,
      identity: async () => undefined,
      outbox: outbox({ attempted: 0, delivered: 0, conflicts: 0, pending: 2 }),
    })
    const body = (await (
      await app.request("/?since=0&until=20&timezone=UTC&view=claxedo&group=harness&filter_harness=codex&limit=1")
    ).json()) as any
    expect(body.claxedo.totals.input).toBe(30)
    expect(body.breakdown).toMatchObject({
      dimension: "harness",
      rows: [expect.objectContaining({ value: "codex", input: 30 })],
    })
    expect(body.filterOptions.claxedo.harness).toEqual(["codex", "pi"])
  })

  test("exposes an authenticated sync wakeup without scanning dashboard history", async () => {
    const flush = vi.fn(async () => ({ attempted: 1, delivered: 1, conflicts: 0, pending: 0 }))
    const app = LocalUsageRoutes({
      local: { current: async () => [], pendingOutbox: async () => [] } as never,
      identity: async () => ({ org_id: "org", user_id: "user" }),
      outbox: { flush, clearIdentity: flush },
    })
    const response = await app.request("/sync", { method: "POST" })
    expect(response.status).toBe(200)
    expect(flush).toHaveBeenCalledWith({ org_id: "org", user_id: "user" })
  })

  test("treats an anonymous sync wakeup as a local-only identity transition", async () => {
    const flush = vi.fn(async () => ({ attempted: 1, delivered: 1, conflicts: 0, pending: 0 }))
    const clearIdentity = vi.fn(async () => ({ attempted: 0, delivered: 0, conflicts: 0, pending: 3 }))
    const app = LocalUsageRoutes({
      local: { current: async () => [], pendingOutbox: async () => [] } as never,
      identity: async () => undefined,
      outbox: { flush, clearIdentity },
    })

    const response = await app.request("/sync", { method: "POST" })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ attempted: 0, delivered: 0, conflicts: 0, pending: 3 })
    expect(clearIdentity).toHaveBeenCalledOnce()
    expect(flush).not.toHaveBeenCalled()
  })

  test("preserves control-plane auth errors on local read and sync routes", async () => {
    const app = LocalUsageRoutes({
      local: { current: async () => [], pendingOutbox: async () => [] } as never,
      identity: async () => {
        throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Bearer token is invalid")
      },
      outbox: outbox({ attempted: 0, delivered: 0, conflicts: 0, pending: 0 }),
    })
    for (const request of [app.request("/?since=0&until=20&timezone=UTC"), app.request("/sync", { method: "POST" })]) {
      const response = await request
      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({
        error: { code: "invalid_bearer_token", message: "Bearer token is invalid" },
      })
    }
  })
})
