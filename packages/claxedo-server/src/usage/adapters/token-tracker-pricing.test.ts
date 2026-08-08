import { describe, expect, test } from "vitest"
import { projectTokenTrackerCost } from "./token-tracker-pricing"

describe("TokenTracker pricing adapter", () => {
  test("prices known categories with versioned catalog metadata", async () => {
    const result = await projectTokenTrackerCost({
      source: "claude",
      model: "claude-sonnet-4-5",
      tokens: { input: 1_000_000, output: 1_000_000, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    })
    expect(result.estimatedUsd).toBe(18)
    expect(result).toMatchObject({ pricedTokens: 2_000_000, unpricedTokens: 0, catalog: { version: "0.75.1" } })
  })

  test("unknown models remain explicitly unpriced rather than fabricated free", async () => {
    const result = await projectTokenTrackerCost({
      source: "claude",
      model: "definitely-not-a-model",
      tokens: { input: 100, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    })
    expect(result).toMatchObject({ estimatedUsd: 0, pricedTokens: 0, unpricedTokens: 120 })
  })
})
