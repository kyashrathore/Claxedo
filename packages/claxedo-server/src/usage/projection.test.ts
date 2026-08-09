import { describe, expect, test } from "vitest"
import { mergeUsageSeries, usageModelKey, usageSeriesFromExternal, usageSeriesFromFacts } from "@claxedo/server-core/usage/projection"
import type { TurnUsageRevision } from "@claxedo/server-core/usage/contracts"

const fact = (revision: number, input: number): TurnUsageRevision => ({
  hostId: "host", sessionRef: "central:s", sessionId: "s", messageId: "m", revision,
  observedAt: Date.UTC(2026, 7, 8, 23, 30), settlement: "final", status: "completed", location: "central",
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

  test("Total is Claxedo plus classified external buckets", () => {
    const claxedo = usageSeriesFromFacts({ facts: [fact(1, 10)], since: 0, until: Number.MAX_SAFE_INTEGER, timeZone: "UTC" })
    const external = usageSeriesFromExternal({
      rows: [{ app: "claude", provider: "anthropic", model: "m", bucketStart: Date.UTC(2026, 7, 8), nativeSessionId: "direct", tokens: { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }],
      since: 0, until: Number.MAX_SAFE_INTEGER, timeZone: "UTC",
    })
    expect(mergeUsageSeries(claxedo, external).totals.input).toBe(15)
  })

  test("counts categories absent from external history as unknown instead of known zero", () => {
    const external = usageSeriesFromExternal({
      rows: [{
        app: "claude", provider: "anthropic", model: "m", bucketStart: Date.UTC(2026, 7, 8), nativeSessionId: "direct",
        tokens: { input: 5, output: 2, reasoning: null, cacheRead: null, cacheWrite: null },
      }],
      since: 0, until: Number.MAX_SAFE_INTEGER, timeZone: "UTC",
    })
    expect(external.totals).toMatchObject({ input: 5, output: 2, reasoning: 0, unknownCategories: 3 })
  })

  test("keeps two models from one native session and bucket as distinct authoritative rows", () => {
    const bucketStart = Date.UTC(2026, 7, 8)
    const external = usageSeriesFromExternal({
      rows: [
        { app: "codex", provider: "openai", model: "gpt-a", bucketStart, nativeSessionId: "direct", tokens: { input: 5, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
        { app: "codex", provider: "openai", model: "gpt-b", bucketStart, nativeSessionId: "direct", tokens: { input: 7, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
      ],
      since: 0,
      until: Number.MAX_SAFE_INTEGER,
      timeZone: "UTC",
    })

    expect(external.totals).toMatchObject({ turnCount: 2, input: 12, output: 3 })
  })
})
