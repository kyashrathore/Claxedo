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

  test("composes independent usage series without changing token totals", () => {
    const claxedo = usageSeriesFromFacts({ facts: [fact(1, 10)], since: 0, until: Number.MAX_SAFE_INTEGER, timeZone: "UTC" })
    const external = usageSeriesFromExternal({
      rows: [{ app: "claude", provider: "anthropic", model: "m", bucketStart: Date.UTC(2026, 7, 8), nativeSessionId: "direct", turnCount: 1, tokens: { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }],
      since: 0, until: Number.MAX_SAFE_INTEGER, timeZone: "UTC",
    })
    expect(mergeUsageSeries(claxedo, external).totals.input).toBe(15)
  })

  test("counts categories absent from external history as unknown instead of known zero", () => {
    const external = usageSeriesFromExternal({
      rows: [{
        app: "claude", provider: "anthropic", model: "m", bucketStart: Date.UTC(2026, 7, 8), nativeSessionId: "direct", turnCount: 1,
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
        { app: "codex", provider: "openai", model: "gpt-a", bucketStart, nativeSessionId: "direct", turnCount: 3, tokens: { input: 5, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
        { app: "codex", provider: "openai", model: "gpt-b", bucketStart, nativeSessionId: "direct", turnCount: 4, tokens: { input: 7, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
      ],
      since: 0,
      until: Number.MAX_SAFE_INTEGER,
      timeZone: "UTC",
    })

    expect(external.totals).toMatchObject({ turnCount: 7, input: 12, output: 3 })
  })

  test("bounds external turn counts by the same range as token totals", () => {
    const included = Date.UTC(2026, 7, 8)
    const external = usageSeriesFromExternal({
      rows: [
        { app: "codex", provider: "openai", model: "gpt-a", bucketStart: included, nativeSessionId: "included", turnCount: 3, tokens: { input: 5, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
        { app: "codex", provider: "openai", model: "gpt-a", bucketStart: Date.UTC(2026, 7, 7), nativeSessionId: "excluded", turnCount: 99, tokens: { input: 100, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
      ],
      since: included,
      until: included,
      timeZone: "UTC",
    })

    expect(external.totals).toMatchObject({ turnCount: 3, input: 5, output: 1 })
  })
})
