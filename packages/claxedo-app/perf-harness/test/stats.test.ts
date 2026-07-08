import { expect, test } from "bun:test"
import { betterThan, percentile, summarize } from "../src/stats"

test("percentile selects the nearest ranked sample", () => {
  expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3)
  expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5)
})

test("summarize computes p95 and variance", () => {
  const summary = summarize({
    metric: "surface_switch_latency_ms",
    value: 0,
    unit: "ms",
    direction: "lower",
    samples: [10, 20, 30],
  })
  expect(summary.p50).toBe(20)
  expect(summary.p95).toBe(30)
  expect(summary.relative_stddev).toBeGreaterThan(0)
})

test("betterThan respects metric direction", () => {
  expect(betterThan(80, 100, "lower", 20)).toBe(true)
  expect(betterThan(120, 100, "higher", 20)).toBe(true)
  expect(betterThan(90, 100, "higher", 20)).toBe(false)
})
