import { describe, expect, test, vi } from "vitest"
import type { ClerkVerifier } from "@claxedo/server-core/platform/auth/auth"
import { LocalUsageRoutes, UsageRoutes } from "./routes"

const authConfig = { enabled: true as const, issuer: "https://auth.test", jwksUrl: "custom:test" }
const verifier: ClerkVerifier = async (token) => ({
  mode: "signed",
  token,
  user: { subject: "user_from_token", orgId: "org_from_token", tokenIdentifier: "token_1", issuer: authConfig.issuer },
})

describe("usage routes", () => {
  test("derives tenant from verified auth and never trusts query identity", async () => {
    const usageDashboard = vi.fn(async () => ({ totals: { turn_count: 1 }, daily: [] }))
    const usageBreakdown = vi.fn(async () => ({ rows: [], next: undefined }))
    const app = UsageRoutes({
      authConfig,
      verifier,
      ledger: { recordLlmTurn: async () => ({ activated: false }), usageDashboard, usageBreakdown },
    })
    const response = await app.request("/?since=1&until=2&group=model&org_id=attacker", {
      headers: { authorization: "Bearer valid" },
    })
    expect(response.status).toBe(200)
    expect(usageDashboard).toHaveBeenCalledWith({
      org_id: "org_from_token", user_id: "user_from_token", since: 1, until: 2, timeZone: "UTC", dimension: "model",
    })
    expect(usageBreakdown).toHaveBeenCalledWith(expect.objectContaining({ org_id: "org_from_token", user_id: "user_from_token", dimension: "model" }))
  })

  test("rejects unsigned, invalid ranges, and invalid group dimensions", async () => {
    const ledger = { recordLlmTurn: async () => ({ activated: false }), usageDashboard: async () => ({}) }
    const app = UsageRoutes({ authConfig, verifier, ledger })
    expect((await app.request("/?since=1&until=2")).status).toBe(401)
    expect((await app.request("/?since=2&until=1", { headers: { authorization: "Bearer valid" } })).status).toBe(400)
    expect((await app.request(`/?since=0&until=${91 * 86_400_000}`, { headers: { authorization: "Bearer valid" } })).status).toBe(400)
    expect((await app.request("/?since=1&until=2&timezone=Mars/Olympus", { headers: { authorization: "Bearer valid" } })).status).toBe(400)
    expect((await app.request("/?since=1&until=2&group=org", { headers: { authorization: "Bearer valid" } })).status).toBe(400)
  })

  test("paginates every model row for cost and returns Claxedo in the app breakdown", async () => {
    const usageBreakdown = vi.fn(async (input: { after?: string }) => input.after
      ? { rows: [{ value: "openai/gpt-5", input_tokens: 7 }], next: undefined }
      : { rows: [{ value: "anthropic/claude-sonnet-5", input_tokens: 5 }], next: "page-2" })
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
    const body = await response.json() as any
    expect(body.breakdown).toEqual({
      dimension: "app",
      rows: [expect.objectContaining({ value: "Claxedo", turnCount: 2, input: 12 })],
    })
    expect(usageBreakdown).toHaveBeenNthCalledWith(2, expect.objectContaining({ after: "page-2" }))
    expect(body.claxedo.cost.pricedTokens + body.claxedo.cost.unpricedTokens).toBe(12)
  })
})

describe("local unified usage route", () => {
  const fact = {
    hostId: "h", sessionRef: "central:s", sessionId: "s", messageId: "m", revision: 1,
    observedAt: 10, settlement: "final", status: "completed", location: "local", harness: "pi",
    providerId: "anthropic", modelId: "m", tokens: { input: 10, output: 2, reasoning: null, cache: { read: 0, write: null } },
    quality: { source: "provider", knownCategories: ["input", "output", "cache_read"] },
  } as const

  test("merges central with pending local and classified external exactly once", async () => {
    const local = { current: async () => [fact], pendingOutbox: async () => [fact] } as never
    const app = LocalUsageRoutes({
      local,
      identity: async () => ({ org_id: "org", user_id: "user" }),
      outbox: { flush: async () => ({ attempted: 0, delivered: 0, conflicts: 0, pending: 1 }) },
      central: {
        recordLlmTurn: async () => ({ activated: false }),
        usageDashboard: async () => ({ totals: { turn_count: 1, input_tokens: 20 }, daily: [] }),
      },
      history: async () => ({
        rows: [{ app: "claude", model: "m", bucketStart: 10, nativeSessionId: "direct", tokens: { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }],
        coverage: [{ source: "claude", status: "available" }],
        classifiedClaxedo: 1,
        unclassified: 0,
      }),
    })
    const response = await app.request("/?since=0&until=20&timezone=UTC")
    const body = await response.json() as any
    expect(body.claxedo.totals.input).toBe(30)
    expect(body.total.totals.input).toBe(35)
    expect(body.claxedo.scope).toBe("cross-machine")
  })

  test("anonymous requests stay local and source failures do not zero Claxedo", async () => {
    const app = LocalUsageRoutes({
      local: { current: async () => [fact], pendingOutbox: async () => [fact] } as never,
      identity: async () => undefined,
      outbox: { flush: async () => ({ attempted: 0, delivered: 0, conflicts: 0, pending: 1 }) },
      history: async () => { throw new Error("scanner unavailable") },
    })
    const body = await (await app.request("/?since=0&until=20&timezone=UTC")).json() as any
    expect(body.claxedo.totals.input).toBe(10)
    expect(body.externalLocal.status).toBe("degraded")
    expect(body.sync.pending).toBe(1)
  })

  test("uses one latest pending revision and includes Claxedo in the total app breakdown", async () => {
    const final = {
      ...fact,
      revision: 2,
      tokens: { ...fact.tokens, input: 20 },
    } as const
    const pendingOutbox = vi.fn(async () => [fact, final])
    const app = LocalUsageRoutes({
      local: { current: async () => [final], pendingOutbox } as never,
      identity: async () => ({ org_id: "org", user_id: "user" }),
      outbox: { flush: async () => ({ attempted: 0, delivered: 0, conflicts: 0, pending: 2 }) },
      central: {
        recordLlmTurn: async () => ({ activated: false }),
        usageDashboard: async () => ({ totals: { turn_count: 0 }, daily: [] }),
      },
      history: async () => ({
        rows: [{ app: "claude", model: "m", bucketStart: 10, nativeSessionId: "direct", tokens: { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }],
        coverage: [], classifiedClaxedo: 0, unclassified: 0,
      }),
    })

    const body = await (await app.request("/?since=0&until=20&timezone=UTC&group=app")).json() as any
    expect(pendingOutbox).toHaveBeenCalledWith({ since: 0, until: 20, all: true })
    expect(body.claxedo.totals.input).toBe(20)
    expect(body.breakdown.localRows).toEqual([
      expect.objectContaining({ value: "Claxedo", turnCount: 1, input: 20 }),
      expect.objectContaining({ value: "claude", turnCount: 1, input: 5 }),
    ])
    expect(body.claxedo.cost.pricedTokens + body.claxedo.cost.unpricedTokens).toBe(22)
  })

  test("does not add an acknowledged fact when local delivery bookkeeping leaves it pending", async () => {
    const app = LocalUsageRoutes({
      local: { current: async () => [fact], pendingOutbox: async () => [fact] } as never,
      identity: async () => ({ org_id: "org", user_id: "user" }),
      outbox: {
        flush: async () => ({
          attempted: 1, delivered: 0, conflicts: 0, pending: 1,
          acknowledged: [{ hostId: fact.hostId, sessionRef: fact.sessionRef, messageId: fact.messageId, revision: fact.revision }],
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
    const body = await (await app.request("/?since=0&until=20&timezone=UTC")).json() as any
    expect(body.claxedo.totals.input).toBe(10)
    expect(body.sync).toEqual({ attempted: 1, delivered: 0, conflicts: 0, pending: 1 })
  })
})
