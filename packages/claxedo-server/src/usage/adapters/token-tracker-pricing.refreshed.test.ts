import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, test } from "vitest"
import { tokenTrackerPricing } from "@claxedo/server-core/usage/adapters/token-tracker-pricing"

const none = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: null }
const home = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }

afterEach(() => {
  for (const [name, value] of Object.entries(home)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

// tokentracker holds one catalog per process, so the refresh below is this
// file's alone: vitest gives every test file its own module graph.
test("the refreshed catalog is tokentracker's cache under the home directory, and a bundled price refuses once it replaced the seed", async () => {
  const temporaryHome = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "tokentracker-home-"))
  const cache = path.join(temporaryHome, ".tokentracker", "cache", "pricing.json")
  fs.mkdirSync(path.dirname(cache), { recursive: true })
  fs.writeFileSync(cache, JSON.stringify({
    "usage-test-model": { input_cost_per_token: 0.000002, output_cost_per_token: 0.000008 },
  }))
  process.env.HOME = temporaryHome
  process.env.USERPROFILE = temporaryHome

  const refreshed = await tokenTrackerPricing("refreshed")({
    source: "anthropic",
    model: "usage-test-model",
    tokens: { ...none, input: 1_000_000, output: 1_000_000 },
  })
  expect(refreshed).toMatchObject({ estimatedUsd: 10, pricedTokens: 2_000_000, catalog: { source: "disk-cache" } })

  await expect(tokenTrackerPricing("bundled")({ source: "anthropic", model: "claude-sonnet-4-5", tokens: none }))
    .rejects.toThrow(/bundled pricing catalog was replaced by a refresh/)
  fs.rmSync(temporaryHome, { recursive: true, force: true })
})
