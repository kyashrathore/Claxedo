import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { TurnUsageRevision } from "@claxedo/server-core/usage/contracts"
import { hostedWorkerCompatibility, wranglerBundle } from "../../test-support/hosted-worker-bundle"
import { applyControlPlaneBaseline } from "../../test-support/control-plane-migrations"

const ENTRY = fileURLToPath(new URL("./d1-usage-ledger.worker-pricing.cf.ts", import.meta.url))

let miniflare: Miniflare | undefined

beforeAll(async () => {
  miniflare = new Miniflare({
    ...hostedWorkerCompatibility(),
    modules: [{ type: "ESModule", path: "worker.js", contents: wranglerBundle(ENTRY) }],
    d1Databases: ["CONTROL_PLANE_DB"],
  })
  const database = await miniflare.getD1Database("CONTROL_PLANE_DB")
  await applyControlPlaneBaseline(database)
}, 120_000)

afterAll(async () => {
  await miniflare?.dispose()
})

const DAY = Date.parse("2026-09-20T10:00:00Z")

const FACT: TurnUsageRevision = {
  sessionRef: "workspace:ws_main:session:ses_1",
  sessionId: "ses_1",
  workspaceId: "ws_main",
  hostId: "workspace:ws_main",
  location: "cloud-workspace",
  messageId: "msg_1",
  revision: 1,
  observedAt: DAY,
  settlement: "final",
  status: "completed",
  harness: "claude",
  providerId: "anthropic",
  modelId: "claude-sonnet-4-5",
  tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 30, write: 10, write1h: 5 } },
  quality: { source: "provider", knownCategories: ["input", "output", "reasoning", "cache_read", "cache_write"] },
}

test("the hosted usage view prices an account's cloud turns inside workerd from the catalog bundled into the Worker", async () => {
  const worker = miniflare!
  const seeded = await worker.dispatchFetch("http://usage.test/seed", { method: "POST", body: JSON.stringify(FACT) })
  expect(await seeded.json()).toEqual({ status: "accepted" })

  const response = await worker.dispatchFetch(`http://usage.test/?since=${DAY - 3_600_000}&until=${DAY + 3_600_000}&group=model`)
  expect(response.status).toBe(200)
  const body = await response.json() as {
    claxedo: {
      totals: Record<string, number>
      cost: { estimatedUsd: number; pricedTokens: number; unpricedTokens: number; catalog: { source: string } }
      locationShare: { localTokens: number; cloudTokens: number }
    }
    breakdown: { rows: Array<{ value: string; status: string; estimatedUsd: number; pricedTokens: number }> }
    modelBreakdown: { rows: Array<{ value: string; status: string; estimatedUsd: number }> }
  }
  // Sonnet 4.5 is priced by the LiteLLM seed, not the curated overrides, per
  // MTok: $3 input, $15 output, $0.30 cache read, $3.75 five-minute cache
  // write, and a one-hour write at twice input.
  const usd = (100 * 3 + 20 * 15 + 30 * 0.3 + 5 * 3.75 + 5 * 6) / 1_000_000
  expect(body.claxedo.totals).toMatchObject({ turnCount: 1, input: 100, output: 20, cacheRead: 30, cacheWrite: 10 })
  expect(body.claxedo.cost).toMatchObject({ pricedTokens: 160, unpricedTokens: 0, catalog: { source: "bundled-seed" } })
  expect(body.claxedo.cost.estimatedUsd).toBeCloseTo(usd, 12)
  expect(body.claxedo.locationShare).toEqual({ localTokens: 0, cloudTokens: 160 })
  expect(body.breakdown.rows).toEqual([
    expect.objectContaining({ value: "anthropic/claude-sonnet-4-5", status: "final", pricedTokens: 160 }),
  ])
  expect(body.breakdown.rows[0].estimatedUsd).toBeCloseTo(usd, 12)
  expect(body.modelBreakdown.rows).toEqual([expect.objectContaining({ value: "anthropic/claude-sonnet-4-5", status: "final" })])
  expect(body.modelBreakdown.rows[0].estimatedUsd).toBeCloseTo(usd, 12)

  const cloud = await worker.dispatchFetch(`http://usage.test/cloud-facts?since=${DAY - 1}&until=${DAY + 1}`)
  expect(cloud.status).toBe(200)
  expect(await cloud.json()).toEqual({ facts: [FACT] })
})
