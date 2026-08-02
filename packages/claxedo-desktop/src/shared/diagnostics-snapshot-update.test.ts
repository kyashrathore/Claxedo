import { expect, test } from "bun:test"
import type { LocalDiagnostics } from "@claxedo/app/process-diagnostics-contract"

import { snapshotDelta } from "../main/diagnostics/ipc"
import { applyDiagnosticsSnapshotUpdate } from "./diagnostics-snapshot-update"

function snapshot(capturedAt: number, samples: LocalDiagnostics.MetricPoint[] = []): LocalDiagnostics.RetainedSnapshot {
  return {
    version: 1,
    generation: "generation-1",
    capturedAt,
    retainedFromAt: samples[0]?.at ?? 0,
    targetWindowMs: 100,
    retention: { state: "complete" },
    owners: [],
    processes: [],
    samples,
    sources: [],
    markers: [],
    interval: {
      startAt: 0,
      endAt: capturedAt,
      sampleCount: samples.length,
      totals: {
        currentCpuMachinePercent: { state: "unavailable", reason: "not-sampled" },
        peakCpuMachinePercent: { state: "unavailable", reason: "not-sampled" },
        currentRssBytes: { state: "unavailable", reason: "not-sampled" },
        peakRssBytes: { state: "unavailable", reason: "not-sampled" },
        rssChangeBytes: { state: "unavailable", reason: "not-sampled" },
      },
      contributors: [],
      churn: [],
    },
  }
}

const point = (at: number): LocalDiagnostics.MetricPoint => ({
  at,
  processId: "host:42:100",
  cpuMachinePercent: { state: "available", value: 1 },
  rssBytes: { state: "available", value: 1_024 },
})

test("snapshot delta reconstructs retained history without retransmitting unchanged samples", () => {
  const previous = snapshot(10, [point(5), point(10)])
  const current = snapshot(15, [point(10), point(15)])
  const delta = snapshotDelta(previous, current)
  expect(delta.sampleUpserts).toEqual([point(15)])
  expect(delta.sampleRemovals).toEqual([{ at: 5, processId: "host:42:100" }])
  expect(applyDiagnosticsSnapshotUpdate(previous, { kind: "delta", delta })).toEqual(current)
})

test("snapshot delta rejects a stale base so preload can request a full resync", () => {
  const previous = snapshot(10, [point(10)])
  const delta = snapshotDelta(previous, snapshot(15, [point(10), point(15)]))
  expect(applyDiagnosticsSnapshotUpdate(snapshot(11, [point(10)]), { kind: "delta", delta })).toBeUndefined()
})
