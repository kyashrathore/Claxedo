import { describe, expect, test } from "bun:test"
import type { LocalDiagnostics } from "@claxedo/app/process-diagnostics-contract"

import {
  DIAGNOSTICS_CPU_OVERHEAD_BUDGET,
  DIAGNOSTICS_RETAINED_BYTES_BUDGET,
  evaluateDiagnosticsEvidence,
  pairedCpuOverhead,
  requirePackagedSourceHealth,
} from "./performance-diagnostics-smoke"

describe("performance diagnostics release evidence", () => {
  test("accepts retained startup attribution, separated server ownership, and honest churn", () => {
    const result = evaluateDiagnosticsEvidence({
      snapshot: snapshot(),
      stats: { retainedBytes: 1_024, droppedTicks: 0, lastReconciliationDurationMs: 2 },
      platform: "linux",
      actionSafety: "verified",
      cpuOverheadPercentagePoints: 0.4,
      requireServer: true,
    })

    expect(result.failures).toEqual([])
    expect(result.evidence).toMatchObject({
      startupHistory: true,
      topContributor: "Diagnostics smoke harness",
      serverSeparated: true,
      memoryGrowth: true,
      churnUnmeasured: true,
      redacted: true,
      actionSafety: "verified",
    })
  })

  test("blocks secret retention and overhead budget violations", () => {
    const input = snapshot()
    input.owners[0] = {
      ...input.owners[0]!,
      label: "claxedo-diagnostics-secret-must-not-cross",
    }
    const result = evaluateDiagnosticsEvidence({
      snapshot: input,
      stats: { retainedBytes: DIAGNOSTICS_RETAINED_BYTES_BUDGET + 1 },
      platform: "linux",
      actionSafety: "verified",
      // Relative to the budget, not a literal: the budget is environment-
      // dependent (looser on CI's shared x64 runners), and a hardcoded 1.01
      // stopped being a violation there — the test passed vacuously on one
      // half of the failure list.
      cpuOverheadPercentagePoints: DIAGNOSTICS_CPU_OVERHEAD_BUDGET + 0.01,
    })

    expect(result.failures).toEqual([
      "a secret sentinel crossed the diagnostics contract",
      expect.stringContaining("retained bytes"),
      expect.stringContaining("CPU overhead"),
    ])
  })

  test("counterbalances disabled and enabled CPU measurements in ABBA order", () => {
    expect(pairedCpuOverhead([2, 5, 4, 3])).toBe(2)
    expect(pairedCpuOverhead([5, 4, 3, 6])).toBe(0)
    expect(() => pairedCpuOverhead([1, 2])).toThrow("four finite non-negative")
  })

  test("requires every native packaged collector to report healthy", () => {
    const sources = [
      source("electron", "healthy"),
      source("windows-cim", "healthy"),
      source("windows-process-tree", "healthy"),
    ]

    expect(requirePackagedSourceHealth({ sources }, "win32")).toEqual({
      electron: "healthy",
      "windows-cim": "healthy",
      "windows-process-tree": "healthy",
    })
    expect(() =>
      requirePackagedSourceHealth(
        { sources: sources.filter((item) => item.source !== "windows-process-tree") },
        "win32",
      ),
    ).toThrow("windows-process-tree=missing")
  })
})

function source(
  id: LocalDiagnostics.SourceId,
  state: "healthy",
): LocalDiagnostics.SourceStatus {
  return {
    source: id,
    domain: "host",
    accuracy: "native",
    capabilities: {
      cpu: true,
      rss: true,
      ancestry: true,
      creationIdentity: true,
      actionIdentity: true,
    },
    state,
    lastSuccessAt: 1,
  }
}

function snapshot(): LocalDiagnostics.RetainedSnapshot {
  return {
    version: 1,
    generation: "smoke-generation",
    capturedAt: 2_000,
    retainedFromAt: 1_000,
    targetWindowMs: 15 * 60_000,
    retention: { state: "complete" },
    owners: [
      {
        id: "smoke-harness",
        kind: "harness",
        label: "Diagnostics smoke harness",
        launchId: "harness-launch",
        access: "local",
        lifecycle: "current",
      },
      {
        id: "server",
        kind: "server",
        label: "Claxedo server",
        launchId: "server-launch",
        access: "local",
        lifecycle: "current",
      },
    ],
    processes: [
      processRecord("host:20:20", 20, "smoke-harness", "harness"),
      processRecord("host:30:30", 30, "server", "server"),
    ],
    samples: [
      {
        at: 1_000,
        processId: "host:20:20",
        cpuMachinePercent: { state: "available", value: 40 },
        rssBytes: { state: "available", value: 64 * 1024 * 1024 },
      },
    ],
    sources: [],
    markers: [
      {
        type: "lifecycle",
        id: "profiler-started",
        at: 900,
        event: "profiler-started",
        source: "electron",
      },
      {
        type: "churn",
        id: "short-cli",
        at: 1_500,
        ownerId: "smoke-harness",
        launched: 1,
        exited: 1,
        shortestDurationMs: 20,
        longestDurationMs: 20,
        resourceMeasurement: { state: "unmeasured", reason: "not-sampled" },
      },
    ],
    interval: {
      startAt: 1_000,
      endAt: 2_000,
      sampleCount: 1,
      totals: {
        currentCpuMachinePercent: { state: "available", value: 40 },
        peakCpuMachinePercent: { state: "available", value: 40 },
        currentRssBytes: { state: "available", value: 64 * 1024 * 1024 },
        peakRssBytes: { state: "available", value: 64 * 1024 * 1024 },
        rssChangeBytes: { state: "available", value: 0 },
      },
      contributors: [{
        ownerId: "smoke-harness",
        peakCpuMachinePercent: { state: "available", value: 40 },
        cpuSharePercent: { state: "available", value: 100 },
        peakRssBytes: { state: "available", value: 64 * 1024 * 1024 },
        rssChangeBytes: { state: "available", value: 32 * 1024 * 1024 },
      }],
      churn: [{
        ownerId: "smoke-harness",
        launched: 1,
        exited: 1,
        resourceMeasurement: "unmeasured",
      }],
    },
  }
}

function processRecord(
  id: string,
  pid: number,
  ownerId: string,
  role: "harness" | "server",
): LocalDiagnostics.ProcessRecord {
  return {
    identity: {
      id,
      domain: "host",
      pid,
      creation: { state: "available", value: String(pid), source: "linux-proc" },
      launchId: `${ownerId}-launch`,
    },
    ownerId,
    role,
    label: role === "server" ? "Claxedo server" : "Diagnostics smoke harness",
    lifecycle: "running",
    actionEligibility: { state: "ineligible", reason: "protected-process" },
  }
}
