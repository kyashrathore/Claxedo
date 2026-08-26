import { describe, expect, test } from "bun:test"
import { baselineFromRecords, compareToBaseline, toleranceFor, type Baseline } from "../src/baseline-store"
import type { PerfRecord } from "../src/perf-record"

const record = (metric: string, value: number | undefined, samples: number[] = []): PerfRecord => ({
  lane: "browser", flow: "session-switch", metric, unit: "ms", samples,
  stack: "solid-1", profile: "laptop-broadband",
  ...(value === undefined ? {} : { value }),
})

const baselineWith = (metrics: Baseline["metrics"]): Baseline => ({
  profile: "laptop-broadband", stack: "solid-1", lane: "browser", flow: "session-switch",
  accepted_at: "2026-08-18T00:00:00.000Z", metrics,
})

describe("tolerance", () => {
  test("widens to the baseline's own spread instead of a fixed percentage", () => {
    // This machine swings ~3x run to run. A fixed 10% band would call that
    // noise a regression every other run.
    const noisy = toleranceFor([20, 60, 30, 55, 25])
    const quiet = toleranceFor([20, 20.4, 19.8, 20.1])
    expect(noisy).toBeGreaterThan(quiet)
    expect(noisy).toBeGreaterThan(0.3)
  })

  test("floors at 5% so a suspiciously quiet baseline is not a hair trigger", () => {
    expect(toleranceFor([100, 100, 100])).toBe(0.05)
  })
})

describe("comparison", () => {
  test("a move inside tolerance is unchanged, not a win", () => {
    const baseline = baselineWith({ flow_complete_ms: { value: 400, samples: [380, 420, 400] } })
    const [result] = compareToBaseline([record("flow_complete_ms", 385)], baseline)
    expect(result.verdict).toBe("unchanged")
  })

  test("a real improvement is scored by the metric's direction", () => {
    const baseline = baselineWith({ flow_complete_ms: { value: 400, samples: [399, 400, 401] } })
    const [result] = compareToBaseline([record("flow_complete_ms", 250)], baseline)
    expect(result.verdict).toBe("improved")
    expect(result.deltaPct).toBeLessThan(0)
  })

  test("a metric the stack cannot supply is absent, never a win", () => {
    // The case that matters for a native port: it has no layout-shift concept.
    // Scoring an absent value as 0 would show the port beating the baseline on
    // a metric it never measured.
    const baseline = baselineWith({ visual_stability: { value: 0.377, samples: [0.377] } })
    const [result] = compareToBaseline([record("visual_stability", undefined)], baseline)
    expect(result.verdict).toBe("absent")
    expect(result.current).toBeUndefined()
  })

  test("a metric with no baseline yet is new rather than improved", () => {
    const [result] = compareToBaseline([record("largest_content_ms", 6228)], baselineWith({}))
    expect(result.verdict).toBe("new")
  })

  test("higher-is-better metrics are not scored backwards", () => {
    // No such metric ships today, but the vocabulary allows one, and a
    // direction-blind comparison would silently invert it.
    const baseline = baselineWith({ frame_p95_ms: { value: 10, samples: [10, 10, 10] } })
    const [result] = compareToBaseline([record("frame_p95_ms", 20)], baseline)
    expect(result.verdict).toBe("regressed")
  })
})

test("accepted baselines persist the discriminated authoritative source identity", () => {
  const sourceIdentity = {
    mode: "crabbox-raw" as const,
    sourceSha256: "a".repeat(64),
    rawSyncFingerprint: "b".repeat(64),
  }
  const baseline = baselineFromRecords([record("retained_heap_bytes", 42)], undefined, sourceIdentity)!
  expect(baseline.commit).toBeUndefined()
  expect(baseline.sourceIdentity).toEqual(sourceIdentity)
})
