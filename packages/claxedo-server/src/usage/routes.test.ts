import { describe, expect, test, vi } from "vitest"
import type { ClerkVerifier } from "@claxedo/server-core/platform/auth/auth"
import { UsageRoutes } from "./routes"

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
    expect(usageDashboard).toHaveBeenCalledWith({ org_id: "org_from_token", user_id: "user_from_token", since: 1, until: 2 })
    expect(usageBreakdown).toHaveBeenCalledWith(expect.objectContaining({ org_id: "org_from_token", user_id: "user_from_token", dimension: "model" }))
  })

  test("rejects unsigned, invalid ranges, and invalid group dimensions", async () => {
    const ledger = { recordLlmTurn: async () => ({ activated: false }), usageDashboard: async () => ({}) }
    const app = UsageRoutes({ authConfig, verifier, ledger })
    expect((await app.request("/?since=1&until=2")).status).toBe(401)
    expect((await app.request("/?since=2&until=1", { headers: { authorization: "Bearer valid" } })).status).toBe(400)
    expect((await app.request("/?since=1&until=2&group=org", { headers: { authorization: "Bearer valid" } })).status).toBe(400)
  })
})
