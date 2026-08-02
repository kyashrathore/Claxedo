/**
 * Config drift guard for the W3.1 shared rate-limit binding.
 *
 * Wrangler does NOT inherit bindings into named environments. Three config bugs
 * in the 2026-07-28 CF review were all "a value nobody noticed was missing", and
 * the relay `[vars]` defect was this exact class: the top-level block looked
 * right, staging silently had nothing. A missing binding here does not fail a
 * deploy or throw at boot — `worker.ts` treats `CLAXEDO_REQUEST_LIMITER` as
 * optional so a lost binding degrades to the per-isolate fuse — which is
 * precisely why it needs a test rather than vigilance: the failure mode is
 * silence, and silence is what the fix was for.
 *
 * Same pattern as `worker-cron-drift.test.ts` (crons in both blocks) and
 * `workspace-relay/src/relay-config-drift.test.ts`.
 */

import { describe, expect, test } from "vitest"
import { readFile } from "node:fs/promises"

const wrangler = () => readFile(new URL("../../../wrangler.toml", import.meta.url), "utf8")

describe("shared rate-limit binding config", () => {
  test("production and staging BOTH declare the rate-limit binding", async () => {
    const config = await wrangler()
    const blocks = [...config.matchAll(/^\[\[(env\.staging\.)?ratelimits\]\]$/gm)].map((match) =>
      match[1] ? "staging" : "production",
    )

    // Exactly one per environment: a duplicate block is a silent
    // last-one-wins in wrangler, not an error.
    expect(blocks.toSorted()).toEqual(["production", "staging"])
  })

  test("both environments bind the name worker.ts actually reads", async () => {
    const config = await wrangler()
    const names = [...config.matchAll(/^\[\[(?:env\.staging\.)?ratelimits\]\]\nname = "([^"]+)"/gm)].map(
      (match) => match[1],
    )

    expect(names).toHaveLength(2)
    // The binding name is the contract between wrangler.toml and
    // `WorkerEnv.CLAXEDO_REQUEST_LIMITER`. A rename on one side is invisible.
    expect(names).toEqual(["CLAXEDO_REQUEST_LIMITER", "CLAXEDO_REQUEST_LIMITER"])
  })

  test("staging uses a DIFFERENT namespace_id so it cannot spend production's budget", async () => {
    const config = await wrangler()
    const ids = [
      ...config.matchAll(/^\[\[(?:env\.staging\.)?ratelimits\]\]\nname = "[^"]+"\nnamespace_id = "([^"]+)"/gm),
    ].map((match) => match[1]!)

    expect(ids).toHaveLength(2)
    // Cloudflare shares counters across every binding with the same
    // namespace_id — even in different Workers. One id here would mean a
    // staging load test rate-limiting production users.
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) expect(id).toMatch(/^\d+$/)
  })

  test("both periods are 60s, matching the local fuse's window", async () => {
    const config = await wrangler()
    const simple = [...config.matchAll(/^\[(?:env\.staging\.)?ratelimits\.simple\]\n\s*limit = (\d+)\n\s*period = (\d+)$/gm)]

    expect(simple).toHaveLength(2)
    for (const [, limit, period] of simple) {
      // Cloudflare accepts ONLY 10 or 60. 60 is pinned to match
      // defaultRequestRateLimitWindowMs (60_000) so the local fuse and the
      // shared store agree on what one window is; a 10 here would silently make
      // the shared ceiling six times tighter than the configured limit implies.
      expect(Number(period)).toBe(60)
      expect(Number(limit)).toBe(600)
    }
  })
})
