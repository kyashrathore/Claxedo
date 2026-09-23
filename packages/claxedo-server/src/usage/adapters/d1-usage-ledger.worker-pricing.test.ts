import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { TurnUsageRevision } from "@claxedo/server-core/usage/contracts"
import { HOSTED_WORKER_BUNDLE_CONTRACT } from "../../../scripts/deploy/hosted-worker-bundle"
import { applyControlPlaneMigration, controlPlaneMigrations } from "../../test-support/control-plane-migrations"

const SERVER_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const ENTRY = fileURLToPath(new URL("./d1-usage-ledger.worker-pricing.cf.ts", import.meta.url))

/**
 * The entry as Wrangler bundles a hosted Worker: its esbuild settings and its
 * Node compatibility layer decide what a CommonJS dependency sees at import,
 * and a hand-rolled esbuild call would decide differently.
 */
function wranglerBundle() {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-worker-pricing-"))
  const config = path.join(workdir, "wrangler.toml")
  fs.writeFileSync(config, `name = "usage-worker-pricing"\nmain = ${JSON.stringify(ENTRY)}\n${HOSTED_WORKER_BUNDLE_CONTRACT}\n`)
  const env: NodeJS.ProcessEnv = { ...process.env, WRANGLER_SEND_METRICS: "false" }
  for (const name of ["CF_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_EMAIL"]) {
    delete env[name]
  }
  const outdir = path.join(workdir, "out")
  const result = spawnSync(
    path.join(SERVER_ROOT, "node_modules/.bin/wrangler"),
    ["deploy", "--config", config, "--dry-run", "--outdir", outdir],
    { cwd: SERVER_ROOT, env, encoding: "utf8" },
  )
  if (result.status !== 0) throw new Error(`wrangler could not bundle the usage Worker:\n${result.stdout}\n${result.stderr}`)
  const bundle = fs.readFileSync(path.join(outdir, "d1-usage-ledger.worker-pricing.cf.js"), "utf8")
  fs.rmSync(workdir, { recursive: true, force: true })
  return bundle
}

function compatibility() {
  const date = /^compatibility_date = "([^"]+)"$/m.exec(HOSTED_WORKER_BUNDLE_CONTRACT)?.[1]
  const flags = /^compatibility_flags = \[([^\]]*)\]$/m.exec(HOSTED_WORKER_BUNDLE_CONTRACT)?.[1]
  if (!date || flags === undefined) throw new Error("the hosted Worker bundle contract declares no compatibility")
  return { compatibilityDate: date, compatibilityFlags: [...flags.matchAll(/"([^"]+)"/g)].map((match) => match[1]) }
}

let miniflare: Miniflare | undefined

beforeAll(async () => {
  miniflare = new Miniflare({
    ...compatibility(),
    modules: [{ type: "ESModule", path: "worker.js", contents: wranglerBundle() }],
    d1Databases: ["CONTROL_PLANE_DB"],
  })
  const database = await miniflare.getD1Database("CONTROL_PLANE_DB")
  for (const name of controlPlaneMigrations()) await applyControlPlaneMigration(database, name)
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
