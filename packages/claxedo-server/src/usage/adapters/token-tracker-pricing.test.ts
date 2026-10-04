import { describe, expect, test } from "vitest"
import { tokenTrackerPricing } from "@claxedo/server-core/usage/adapters/token-tracker-pricing"

const none = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: null }
const price = tokenTrackerPricing("bundled")

describe("TokenTracker pricing adapter, bundled catalog", () => {
  test("prices a model only the LiteLLM seed carries without loading anything", async () => {
    const result = await price({
      source: "anthropic",
      model: "claude-sonnet-4-5",
      tokens: { ...none, input: 1_000_000, cacheRead: 1_000_000 },
    })
    expect(result).toEqual({
      estimatedUsd: 3.3,
      pricedTokens: 2_000_000,
      unpricedTokens: 0,
      catalog: { adapter: "tokentracker-cli", version: "0.91.0", source: "bundled-seed" },
    })
  })

  test("prices known categories with versioned catalog metadata", async () => {
    const result = await price({
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
    const result = await price({
      source: "claude",
      model: "definitely-not-a-model",
      tokens: { ...none, input: 100, output: 20 },
    })
    expect(result).toMatchObject({ estimatedUsd: 0, pricedTokens: 0, unpricedTokens: 120 })
  })

  test("prices disjoint Codex reasoning at the output rate", async () => {
    const withoutReasoning = await price({
      source: "codex",
      model: "gpt-5",
      tokens: { ...none, output: 1_000_000 },
    })
    const withReasoning = await price({
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
      const result = await price({
        source: "claude",
        model,
        tokens: { ...none, [category]: 1_000_000 },
      })
      expect({ category, usd: result.estimatedUsd }).toEqual({ category, usd: rate })
    }
  })

  const rateOf = async (source: string, model: string, category: "input" | "output" | "cacheRead" | "cacheWrite") =>
    (await price({ source, model, tokens: { ...none, [category]: 1_000_000 } })).estimatedUsd

  test.each([
    ["claude-fable-5-1[1m]", "claude-fable-5-1"],
    ["claude-opus-5-5-20260915", "claude-opus-5-5"],
    ["claude-opus-5-5-20260915[1m]", "claude-opus-5-5"],
  ])("prices %s at %s's rates", async (model, base) => {
    for (const source of ["claude", "anthropic"]) {
      for (const category of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        const baseUsd = await rateOf(source, base, category)
        expect(baseUsd).toBeGreaterThan(0)
        expect({ source, category, usd: await rateOf(source, model, category) }).toEqual({ source, category, usd: baseUsd })
      }
    }
  })

  test.each(["claude-opus-5-6", "claude-opus-5-6[1m]", "claude-fable-5-2", "claude-sonnet-5-1"])(
    "leaves the unreleased %s unpriced rather than pricing it as its predecessor",
    async (model) => {
      for (const source of ["claude", "anthropic"]) {
        const result = await price({ source, model, tokens: { ...none, input: 100, output: 20 } })
        expect({ source, result }).toMatchObject({ source, result: { estimatedUsd: 0, pricedTokens: 0, unpricedTokens: 120 } })
      }
    },
  )

  // Every model the Claude Code and Codex transcripts on the development
  // machine used from 2026-09-16 to 2026-09-23, and the other two GPT-6 tiers.
  // A Worker prices from this catalog alone.
  test.each([
    ["claude", "claude-opus-5"],
    ["claude", "claude-opus-5-5"],
    ["claude", "claude-fable-5-1"],
    ["claude", "claude-sonnet-5"],
    ["claude", "claude-sonnet-4-6"],
    ["claude", "claude-haiku-4-5-20251001"],
    ["codex", "gpt-6-astra"],
    ["codex", "gpt-6-sol"],
    ["codex", "gpt-6-luna"],
    ["codex", "gpt-5.6-terra"],
    ["codex", "gpt-5.6-luna"],
    ["codex", "gpt-5.5"],
  ])("the bundled catalog prices %s's %s", async (source, model) => {
    const result = await price({ source, model, tokens: { ...none, input: 1_000_000, output: 1_000_000 } })
    expect(result).toMatchObject({ pricedTokens: 2_000_000, unpricedTokens: 0 })
    expect(result.estimatedUsd).toBeGreaterThan(0)
  })

  // LiteLLM model_prices_and_context_window.json as cached on 2026-09-23T06:46:11Z, in USD per MTok.
  test.each([
    ["gpt-6-astra", { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }],
    ["gpt-6-sol", { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
    ["gpt-6-luna", { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }],
  ] as const)("prices %s at LiteLLM's published rates", async (model, rates) => {
    for (const [category, rate] of Object.entries(rates)) {
      expect({ category, usd: await rateOf("codex", model, category as keyof typeof rates) }).toEqual({ category, usd: rate })
    }
  })

  test("prices one-hour cache writes at twice input and the rest at the five-minute rate", async () => {
    const result = await price({
      source: "claude",
      model: "claude-opus-5",
      tokens: { ...none, cacheWrite: 3_000_000, cacheWrite1h: 1_000_000 },
    })
    expect(result.estimatedUsd).toBe(2 * 6.25 + 10)
    expect(result.pricedTokens).toBe(3_000_000)
  })
})
