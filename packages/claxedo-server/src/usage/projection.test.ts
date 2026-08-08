import { describe, expect, test } from "vitest"
import { mergeUsageSeries, usageSeriesFromExternal, usageSeriesFromFacts } from "./projection"
import type { TurnUsageRevision } from "./contracts"

const fact = (revision: number, input: number): TurnUsageRevision => ({
  hostId: "host", sessionRef: "central:s", sessionId: "s", messageId: "m", revision,
  observedAt: Date.UTC(2026, 7, 8, 23, 30), settlement: "final", status: "completed", location: "central",
  harness: "pi", providerId: "anthropic", modelId: "m", tokens: { input, output: 2, reasoning: null, cache: { read: 0, write: null } },
  quality: { source: "provider", knownCategories: ["input", "output", "cache_read"] },
})

describe("usage projection", () => {
  test("preserves category quality and timezone day boundaries", () => {
    const series = usageSeriesFromFacts({ facts: [fact(2, 10)], since: 0, until: Number.MAX_SAFE_INTEGER, timeZone: "Asia/Kolkata" })
    expect(series.totals).toMatchObject({ turnCount: 1, input: 10, output: 2, unknownCategories: 2 })
    expect(series.daily[0]?.date).toBe("2026-08-09")
  })

  test("Total is Claxedo plus classified external buckets", () => {
    const claxedo = usageSeriesFromFacts({ facts: [fact(1, 10)], since: 0, until: Number.MAX_SAFE_INTEGER, timeZone: "UTC" })
    const external = usageSeriesFromExternal({
      rows: [{ app: "claude", model: "m", bucketStart: Date.UTC(2026, 7, 8), nativeSessionId: "direct", tokens: { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }],
      since: 0, until: Number.MAX_SAFE_INTEGER, timeZone: "UTC",
    })
    expect(mergeUsageSeries(claxedo, external).totals.input).toBe(15)
  })
})
