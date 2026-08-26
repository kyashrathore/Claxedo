import { describe, expect, test } from "bun:test"
import {
  blockedFrameRatio,
  eventTimingP95,
  resourceMetrics,
  terminalThroughput,
} from "../src/agent-metrics"

describe("agent-app benchmark metric semantics", () => {
  test("keeps sub-threshold Event Timing probes left-censored", () => {
    expect(eventTimingP95({
      probeCount: 40,
      durationThresholdMs: 16,
      entries: [],
    })).toEqual({ state: "bounded", upperBound: 16, unit: "ms", reason: "below-event-timing-threshold" })
  })

  test("computes Event Timing p95 only when the order statistic is observed", () => {
    expect(eventTimingP95({
      probeCount: 40,
      durationThresholdMs: 16,
      entries: [
        { interactionId: 1, durationMs: 20 },
        { interactionId: 2, durationMs: 24 },
        { interactionId: 3, durationMs: 40 },
      ],
    })).toEqual({ state: "exact", value: 20, unit: "ms" })
  })

  test("rejects duplicate or unmatched interaction evidence", () => {
    expect(eventTimingP95({
      probeCount: 2,
      durationThresholdMs: 16,
      entries: [
        { interactionId: 4, durationMs: 20 },
        { interactionId: 4, durationMs: 24 },
      ],
    })).toMatchObject({ state: "invalid", reason: "duplicate-interaction-id" })
  })

  test("uses Long Animation Frame blocking duration rather than frame duration", () => {
    expect(blockedFrameRatio({
      scenarioDurationMs: 1_000,
      supported: true,
      entries: [
        { durationMs: 80, blockingDurationMs: 30 },
        { durationMs: 120, blockingDurationMs: 70 },
      ],
    })).toEqual({ state: "exact", value: 10, unit: "percent" })
  })

  test("marks unsupported Long Animation Frames distinctly", () => {
    expect(blockedFrameRatio({ scenarioDurationMs: 1_000, supported: false, entries: [] }))
      .toEqual({ state: "unsupported", reason: "long-animation-frame-unavailable" })
  })

  test("gates terminal throughput on exact output and responsive concurrent input", () => {
    expect(terminalThroughput({
      bytes: 2 * 1024 * 1024,
      startedAtMs: 100,
      paintedAtMs: 1_100,
      exactModelHash: true,
      concurrentInputP95Ms: 80,
      minimumDurationMs: 1_000,
    })).toEqual({ state: "exact", value: 2, unit: "MiB/s" })

    expect(terminalThroughput({
      bytes: 2 * 1024 * 1024,
      startedAtMs: 100,
      paintedAtMs: 1_100,
      exactModelHash: false,
      concurrentInputP95Ms: 80,
      minimumDurationMs: 1_000,
    })).toMatchObject({ state: "invalid", reason: "terminal-model-mismatch" })

    expect(terminalThroughput({
      bytes: 2 * 1024 * 1024,
      startedAtMs: 100,
      paintedAtMs: 1_100,
      exactModelHash: true,
      concurrentInputP95Ms: 101,
      minimumDurationMs: 1_000,
    })).toMatchObject({ state: "invalid", reason: "terminal-input-unresponsive" })

    expect(terminalThroughput({
      bytes: 320 * 1024 * 1024,
      startedAtMs: 0,
      paintedAtMs: 9_999,
      exactModelHash: true,
      concurrentInputP95Ms: 80,
      minimumDurationMs: 10_000,
    })).toMatchObject({ state: "invalid", reason: "terminal-duration-too-short" })
  })

  test("derives sampled peak RSS and quiescent CPU p95 from valid cadence", () => {
    const samples = Array.from({ length: 61 }, (_, index) => ({
      atMs: index * 1_000,
      rssBytes: (100 + index) * 1024 * 1024,
      cpuPercent: index,
    }))
    expect(resourceMetrics({ samples, requestedIntervalMs: 1_000, expectedDurationMs: 60_000 }))
      .toEqual({
        peakRss: { state: "exact", value: 160, unit: "MiB" },
        cpuP95: { state: "exact", value: 57, unit: "percent" },
        achievedSamples: 61,
        expectedSamples: 61,
      })
  })

  test("invalidates resource metrics when cadence has an unexplained gap", () => {
    expect(resourceMetrics({
      samples: [
        { atMs: 0, rssBytes: 100, cpuPercent: 1 },
        { atMs: 3_000, rssBytes: 200, cpuPercent: 2 },
      ],
      requestedIntervalMs: 1_000,
      expectedDurationMs: 3_000,
    })).toMatchObject({
      peakRss: { state: "invalid", reason: "resource-sample-gap" },
      cpuP95: { state: "invalid", reason: "resource-sample-gap" },
    })
  })
})
