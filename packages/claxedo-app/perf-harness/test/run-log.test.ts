import { describe, expect, test } from "bun:test"
import { runLogEntry } from "../src/run-log"
import type { PerfRecord } from "../src/perf-record"
import type { MetricComparison } from "../src/baseline-store"

const record = (metric: string, value?: number): PerfRecord => ({
  lane: "memory", flow: "session-accumulation", metric, unit: "bytes", samples: [],
  stack: "solid-1", profile: "laptop-broadband",
  ...(value === undefined ? {} : { value }),
})

describe("run log entry", () => {
  test("carries the commit, machine and stack, which are what make a number comparable", () => {
    // A measurement without these cannot be compared to anything later: the
    // same flow on the same code reads ~3x differently on a cold container.
    const entry = runLogEntry({
      records: [record("retained_heap_bytes", 85_000_000)],
      commit: "24faae3",
      at: "2026-08-18T00:00:00.000Z",
    })!
    expect(entry.commit).toBe("24faae3")
    expect(entry.profile).toBe("laptop-broadband")
    expect(entry.stack).toBe("solid-1")
    expect(entry.lane).toBe("memory")
    expect(entry.metrics.retained_heap_bytes).toBe(85_000_000)
  })

  test("records an absent metric as null rather than dropping it", () => {
    // Omitting it makes a metric the stack could not supply indistinguishable
    // from one that was never in the vocabulary — which is exactly the
    // confusion a cross-stack comparison has to avoid.
    const entry = runLogEntry({
      records: [record("interaction_latency_ms")],
      at: "2026-08-18T00:00:00.000Z",
    })!
    expect(entry.metrics).toHaveProperty("interaction_latency_ms")
    expect(entry.metrics.interaction_latency_ms).toBeNull()
  })

  test("keeps the distilled finding, not the artifact it came from", () => {
    // Heap snapshots run to hundreds of MB; the retainer table is the part
    // anyone reads and is a few hundred bytes.
    const entry = runLogEntry({
      records: [record("retained_heap_bytes", 1)],
      at: "2026-08-18T00:00:00.000Z",
      evidence: { detachedNodesGrowth: 9728, listenerGrowth: 4611 },
    })!
    expect(entry.evidence).toEqual({ detachedNodesGrowth: 9728, listenerGrowth: 4611 })
  })

  test("carries verdicts when a baseline existed, and omits them when none did", () => {
    const comparison: MetricComparison[] = [
      { metric: "retained_heap_bytes", tolerancePct: 15, verdict: "regressed", deltaPct: 40 },
    ]
    const withBaseline = runLogEntry({
      records: [record("retained_heap_bytes", 1)], comparison, at: "2026-08-18T00:00:00.000Z",
    })!
    expect(withBaseline.verdicts).toEqual({ retained_heap_bytes: "regressed" })

    const without = runLogEntry({
      records: [record("retained_heap_bytes", 1)], comparison: [], at: "2026-08-18T00:00:00.000Z",
    })!
    expect(without.verdicts).toBeUndefined()
  })

  test("a run that produced no records produces no entry", () => {
    expect(runLogEntry({ records: [], at: "2026-08-18T00:00:00.000Z" })).toBeUndefined()
  })
})

test("records the host, because the profile is emulation and not a machine", () => {
  // Two machines running one profile label themselves identically while
  // producing numbers that differ several-fold. Without this field a log line
  // from a laptop and one from a cloud container are indistinguishable, and
  // the 3x gap between them reads as a regression or a win.
  const entry = runLogEntry({
    records: [record("retained_heap_bytes", 85_000_000)],
    at: "2026-08-19T00:00:00.000Z",
  })!
  expect(entry.host).toBeDefined()
  expect(entry.host!.cores).toBeGreaterThan(0)
  expect(entry.host!.platform).toContain(process.platform)
  expect(entry.host!.cpu.length).toBeGreaterThan(0)
})
