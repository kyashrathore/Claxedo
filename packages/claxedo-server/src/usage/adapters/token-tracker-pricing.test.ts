import { describe, expect, test } from "vitest"
import { projectTokenTrackerCost } from "@claxedo/server-core/usage/adapters/token-tracker-pricing"

const none = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: null }

describe("TokenTracker pricing adapter", () => {
  test("prices known categories with versioned catalog metadata", async () => {
    const result = await projectTokenTrackerCost({
      source: "claude",
      model: "claude-sonnet-4-5",
      tokens: { ...none, input: 1_000_000, output: 1_000_000 },
    })
    expect(result.estimatedUsd).toBe(18)
    expect(result).toMatchObject({
      pricedTokens: 2_000_000,
      unpricedTokens: 0,
      catalog: { version: "0.91.0", source: expect.any(String) },
    })
  })

  test("unknown models remain explicitly unpriced rather than fabricated free", async () => {
    const result = await projectTokenTrackerCost({
      source: "claude",
      model: "definitely-not-a-model",
      tokens: { ...none, input: 100, output: 20 },
    })
    expect(result).toMatchObject({ estimatedUsd: 0, pricedTokens: 0, unpricedTokens: 120 })
  })

  test("prices disjoint Codex reasoning at the output rate", async () => {
    const withoutReasoning = await projectTokenTrackerCost({
      source: "codex",
      model: "gpt-5",
      tokens: { ...none, output: 1_000_000 },
    })
    const withReasoning = await projectTokenTrackerCost({
      source: "codex",
      model: "gpt-5",
      tokens: { ...none, output: 1_000_000, reasoning: 1_000_000 },
    })
    expect(withReasoning.estimatedUsd).toBeGreaterThan(withoutReasoning.estimatedUsd)
  })

  // Rates from platform.claude.com/docs/en/about-claude/pricing, 2026-09-23, in USD per MTok.
  test.each([
    ["claude-fable-5-1", { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }],
    ["claude-opus-5-5", { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }],
    ["claude-opus-5", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
    ["claude-sonnet-5", { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
  ] as const)("prices %s at Anthropic's published rates", async (model, rates) => {
    for (const [category, rate] of Object.entries(rates)) {
      const result = await projectTokenTrackerCost({
        source: "claude",
        model,
        tokens: { ...none, [category]: 1_000_000 },
      })
      expect({ category, usd: result.estimatedUsd }).toEqual({ category, usd: rate })
    }
  })

  test("prices one-hour cache writes at twice input and the rest at the five-minute rate", async () => {
    const result = await projectTokenTrackerCost({
      source: "claude",
      model: "claude-opus-5",
      tokens: { ...none, cacheWrite: 3_000_000, cacheWrite1h: 1_000_000 },
    })
    expect(result.estimatedUsd).toBe(2 * 6.25 + 10)
    expect(result.pricedTokens).toBe(3_000_000)
  })
})
