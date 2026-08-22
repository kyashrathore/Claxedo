import { describe, expect, test } from "bun:test"
import {
  IdleProcessFamilyTracker,
  parseIdleProcessTable,
  summarizeIdleResourceWindow,
  type IdleProcessRow,
} from "../src/idle-process-family"

const startedAtMs = Date.parse("Sun Mar 29 12:34:56 2026")
const row = (pid: number, ppid: number, input: Partial<IdleProcessRow> = {}): IdleProcessRow => ({
  pid,
  ppid,
  rssBytes: 1_024,
  cpuSeconds: 0,
  startedAtMs,
  command: `process-${String(pid)}`,
  ...input,
})

describe("idle process-family sampling", () => {
  test("parses RSS, cumulative CPU, stable start identity, and commands from ps", () => {
    const rows = parseIdleProcessTable([
      " 101 1 2048 01:02.50 Sun Mar 29 12:34:56 2026 /Applications/Claxedo --flag value",
      " 102 101 512 2-03:04:05 Mon Mar 30 01:02:03 2026 helper",
      "not a process row",
    ].join("\n"))

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      pid: 101,
      ppid: 1,
      rssBytes: 2_097_152,
      cpuSeconds: 62.5,
      command: "/Applications/Claxedo --flag value",
    })
    expect(rows[1]!.cpuSeconds).toBe(183_845)
  })

  test("discovers arbitrary-depth descendants and retains ownership after reparenting", () => {
    const tracker = new IdleProcessFamilyTracker(10)
    const initial = tracker.observe([
      row(99, 1),
      row(10, 1),
      row(11, 10),
      row(12, 11),
      row(13, 12),
      row(14, 13),
      row(15, 14),
      row(16, 15),
    ], startedAtMs + 10_000)
    expect(initial.pids).toEqual([10, 11, 12, 13, 14, 15, 16])

    const afterRootExit = tracker.observe([
      row(99, 1),
      row(14, 1, { cpuSeconds: 0.1 }),
      row(15, 14, { cpuSeconds: 0.2 }),
      row(16, 15, { cpuSeconds: 0.3 }),
      row(17, 16, { cpuSeconds: 0.4, startedAtMs: startedAtMs + 10_500 }),
    ], startedAtMs + 11_000)
    expect(afterRootExit.pids).toEqual([14, 15, 16, 17])
    expect(afterRootExit.disappearedPids).toEqual([10, 11, 12, 13])
    expect(afterRootExit.cpuPercent).toBeCloseTo(100)
  })

  test("resets the CPU baseline at the declared sampling-window boundary", () => {
    const tracker = new IdleProcessFamilyTracker(10)
    tracker.observe([row(10, 1, { cpuSeconds: 0 })], startedAtMs + 1_000)
    expect(tracker.observe([row(10, 1, { cpuSeconds: 5 })], startedAtMs + 6_000).cpuPercent).toBe(100)

    tracker.resetSamplingBaseline()
    expect(tracker.observe([row(10, 1, { cpuSeconds: 5 })], startedAtMs + 7_000).cpuPercent).toBeUndefined()
    expect(tracker.observe([row(10, 1, { cpuSeconds: 5.2 })], startedAtMs + 8_000).cpuPercent).toBeCloseTo(20)
  })

  test("does not attach descendants of a reused known PID", () => {
    const tracker = new IdleProcessFamilyTracker(10)
    tracker.observe([row(10, 1), row(11, 10)], startedAtMs + 10_000)
    const reused = row(11, 1, { startedAtMs: startedAtMs + 20_000 })
    const observation = tracker.observe([reused, row(12, 11, { startedAtMs: startedAtMs + 20_000 })], startedAtMs + 21_000)
    expect(observation.pids).toEqual([])
    expect(tracker.survivors([reused, row(12, 11, { startedAtMs: startedAtMs + 20_000 })])).toEqual([])
  })

  test("reports a valid explicit 30-minute window and nearest-rank p95", () => {
    const durationMs = 30 * 60 * 1_000
    const observations = Array.from({ length: 1_801 }, (_, index) => ({
      atMs: startedAtMs + index * 1_000,
      rssBytes: 100 + index,
      processCount: 2,
      pids: [10, 11],
      discoveredPids: [],
      disappearedPids: [],
      ...(index === 0 ? {} : { cpuPercent: index % 100 }),
    }))
    const summary = summarizeIdleResourceWindow(observations, durationMs, 1_000)
    expect(summary).toMatchObject({
      valid: true,
      expectedCpuSamples: 1_800,
      achievedCpuSamples: 1_800,
      peakRssBytes: 1_900,
      finalRssBytes: 1_900,
      cpuP95Percent: 94,
      maxSampleGapMs: 1_000,
    })
  })

  test("invalidates short and gapped measurement windows", () => {
    const summary = summarizeIdleResourceWindow([
      { atMs: 0, rssBytes: 100, processCount: 1, pids: [10], discoveredPids: [], disappearedPids: [] },
      { atMs: 3_000, rssBytes: 100, processCount: 1, pids: [10], discoveredPids: [], disappearedPids: [], cpuPercent: 0 },
    ], 4_000, 1_000)
    expect(summary.valid).toBe(false)
    expect(summary.invalidReasons).toEqual(["sample-gap", "short-window", "insufficient-cpu-samples"])
  })
})
