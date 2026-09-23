import { afterEach, expect, test, vi } from "vitest"
import { UsageRoutes } from "@claxedo/server-core/usage/routes"
import { controlPlaneMigrations, miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../../test-support/control-plane-migrations"
import { createD1UsageLedger } from "./d1-usage-ledger"

// What the Wrangler-bundled catalog throws inside workerd.
vi.mock("@claxedo/server-core/usage/adapters/token-tracker-pricing", async (importOriginal) => ({
  ...await importOriginal<typeof import("@claxedo/server-core/usage/adapters/token-tracker-pricing")>(),
  projectTokenTrackerCost: async () => {
    throw new ReferenceError("__dirname is not defined")
  },
}))

const databases: ControlPlaneDatabase[] = []

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.dispose()))
})

test("the hosted usage view still answers an account's cloud tokens when the pricing catalog cannot load", async () => {
  const database = await miniflareControlPlaneDatabase(controlPlaneMigrations())
  databases.push(database)
  const ledger = createD1UsageLedger({ database: database.database })
  const day = Date.parse("2026-09-20T10:00:00Z")
  await ledger.writeRevision({
    sessionRef: "workspace:ws_main:session:ses_1",
    sessionId: "ses_1",
    workspaceId: "ws_main",
    hostId: "workspace:ws_main",
    location: "cloud-workspace",
    messageId: "msg_1",
    revision: 1,
    observedAt: day,
    settlement: "final",
    status: "completed",
    harness: "claude",
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5",
    tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 30, write: 10, write1h: 5 } },
    quality: { source: "provider", knownCategories: ["input", "output", "reasoning", "cache_read", "cache_write"] },
  }, { owner: { org_id: "org_acme", user_id: "user_alice" } })
  const routes = UsageRoutes({ ledger, identity: async () => ({ org_id: "org_acme", user_id: "user_alice" }) })

  const response = await routes.request(`/?since=${day - 3_600_000}&until=${day + 3_600_000}&group=model`)

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    claxedo: {
      totals: { turnCount: 1, input: 100, output: 20, cacheRead: 30, cacheWrite: 10 },
      cost: { estimatedUsd: 0, pricedTokens: 0, unpricedTokens: 160 },
      locationShare: { localTokens: 0, cloudTokens: 160 },
    },
    breakdown: { rows: [{ value: "anthropic/claude-sonnet-4-5", status: "unpriced", unpricedTokens: 160 }] },
  })
})
