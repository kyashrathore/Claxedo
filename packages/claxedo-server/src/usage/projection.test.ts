import { performance } from "node:perf_hooks"
import { describe, expect, test } from "vitest"
import { usageModelKey, usageSeriesFromFacts } from "@claxedo/server-core/usage/projection"
import type { TurnUsageRevision } from "@claxedo/server-core/usage/contracts"

const fact = (revision: number, input: number): TurnUsageRevision => ({
  hostId: "host", sessionRef: "central:s", sessionId: "s", messageId: "m", revision,
  observedAt: Date.UTC(2026, 7, 8, 23, 30), settlement: "final", status: "completed", location: "cloud-workspace",
  harness: "pi", providerId: "anthropic", modelId: "m", tokens: { input, output: 2, reasoning: null, cache: { read: 0, write: null } },
  quality: { source: "provider", knownCategories: ["input", "output", "cache_read"] },
})

describe("usage projection", () => {
  test("keeps already-qualified model IDs canonical", () => {
    expect(usageModelKey("openai", "gpt-5")).toBe("openai/gpt-5")
    expect(usageModelKey("clinepass-1", "cline-pass/kimi-k3")).toBe("cline-pass/kimi-k3")
  })

  test("preserves category quality and timezone day boundaries", () => {
    const series = usageSeriesFromFacts({ facts: [fact(2, 10)], since: 0, until: Number.MAX_SAFE_INTEGER, timeZone: "Asia/Kolkata" })
    expect(series.totals).toMatchObject({ turnCount: 1, input: 10, output: 2, unknownCategories: 2 })
    expect(series.daily[0]?.date).toBe("2026-08-09")
  })

  test("projects 7, 30 and 90 days of 120 turns a day within their budgets", () => {
    const day = 86_400_000
    const now = Date.UTC(2026, 7, 9, 12)
    const facts: TurnUsageRevision[] = []
    for (let offset = 0; offset < 90; offset += 1) {
      for (let turn = 0; turn < 120; turn += 1) {
        facts.push({
          ...fact(1, 100),
          hostId: `host-${turn % 3}`,
          sessionId: `s-${turn % 4}`,
          sessionRef: `central:s-${turn % 4}`,
          messageId: `m-${offset}-${turn}`,
          observedAt: now - offset * day - turn,
        })
      }
    }
    const budgetMs = { 7: 40, 30: 80, 90: 180 } as const
    for (const days of [7, 30, 90] as const) {
      const started = performance.now()
      const series = usageSeriesFromFacts({ facts, since: now - days * day, until: now, timeZone: "UTC" })
      const elapsed = performance.now() - started
      expect(series.daily.length).toBeLessThanOrEqual(days + 1)
      expect(elapsed).toBeLessThanOrEqual(budgetMs[days])
    }
  })
})
