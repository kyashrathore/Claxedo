import { describe, expect, test } from "bun:test"
import type { LocalDiagnostics } from "../../data/local-diagnostics"

import { buildDiagnosticsModel, liveRange, ownerGroup } from "./model"

const snapshot = {
  version: 1,
  generation: "generation-1",
  capturedAt: 3_000,
  retainedFromAt: 1_000,
  targetWindowMs: 15 * 60_000,
  retention: { state: "complete" },
  owners: [
    {
      id: "owner-harness",
      kind: "harness",
      label: "Codex",
      launchId: "launch-harness",
      access: "local",
      lifecycle: "current",
    },
    {
      id: "owner-server",
      kind: "runtime",
      label: "Workspace activity",
      access: "local",
      lifecycle: "current",
    },
  ],
  processes: [
    {
      identity: {
        id: "host:42:100",
        domain: "host",
        pid: 42,
        creation: { state: "available", value: "100", source: "linux-proc" },
        launchId: "launch-harness",
      },
      ownerId: "owner-harness",
      role: "harness",
      label: "Codex",
      lifecycle: "running",
      actionEligibility: {
        state: "eligible",
        actions: [{ action: "stop", token: "opaque-diagnostics-token-0001", expiresAt: 5_000 }],
      },
    },
    {
      identity: {
        id: "host:50:200",
        domain: "host",
        pid: 50,
        creation: { state: "available", value: "200", source: "electron" },
      },
      ownerId: "owner-server",
      role: "runtime",
      label: "Workspace activity",
      lifecycle: "running",
      actionEligibility: { state: "ineligible", reason: "protected-process" },
    },
  ],
  samples: [
    point(1_000, "host:42:100", 10, 100),
    point(1_000, "host:50:200", 20, 200),
    point(2_000, "host:42:100", 80, 300),
    point(2_000, "host:50:200", 5, 250),
    point(3_000, "host:42:100", 2, 200),
  ],
  sources: [],
  markers: [{
    type: "churn",
    id: "churn-1",
    at: 2_000,
    ownerId: "owner-harness",
    launched: 1,
    exited: 1,
    shortestDurationMs: 20,
    longestDurationMs: 20,
    resourceMeasurement: { state: "unmeasured", reason: "not-sampled" },
  }],
  interval: {
    startAt: 1_000,
    endAt: 3_000,
    sampleCount: 3,
    totals: {
      currentCpuMachinePercent: { state: "available", value: 2 },
      peakCpuMachinePercent: { state: "available", value: 85 },
      currentRssBytes: { state: "available", value: 200 },
      peakRssBytes: { state: "available", value: 550 },
      rssChangeBytes: { state: "available", value: -100 },
    },
    contributors: [],
    churn: [{ ownerId: "owner-harness", launched: 1, exited: 1, resourceMeasurement: "unmeasured" }],
  },
} satisfies LocalDiagnostics.RetainedSnapshot

describe("diagnostics view model", () => {
  test("ranks the retained window by actual peak contribution", () => {
    const model = buildDiagnosticsModel(snapshot)
    expect(model.bounds).toEqual({ startAt: 1_000, endAt: 3_000 })
    expect(model.series).toEqual([
      { at: 1_000, cpu: 30, rssBytes: 300 },
      { at: 2_000, cpu: 85, rssBytes: 550 },
      { at: 3_000, cpu: 2, rssBytes: 200 },
    ])
    expect(model.contributors.map((item) => item.owner.id)).toEqual(["owner-harness", "owner-server"])
    expect(model.contributors[0]).toMatchObject({
      peakCpu: 80,
      currentRssBytes: 200,
      rssChangeBytes: 100,
      confidence: "direct",
      actionEligibility: { state: "eligible" },
    })
    expect(model.churn).toEqual([
      { ownerId: "owner-harness", launched: 1, exited: 1, resourceMeasurement: "unmeasured" },
    ])
  })

  test("shows only process generations sampled inside the retained window", () => {
    const historical = {
      ...snapshot.processes[0]!,
      identity: {
        ...snapshot.processes[0]!.identity,
        id: "host:42:old",
        creation: { state: "available" as const, value: "old", source: "linux-proc" as const },
      },
      lifecycle: "exited" as const,
    }
    const model = buildDiagnosticsModel({
      ...snapshot,
      processes: [historical, ...snapshot.processes],
      samples: [point(500, historical.identity.id, 99, 999), ...snapshot.samples],
    })

    expect(model.contributors[0]?.processes.map((process) => process.identity.id)).toEqual([
      "host:42:100",
    ])
  })

  test("bounds the window by the collector's retained span, not the sample extent", () => {
    expect(liveRange(snapshot)).toEqual({ startAt: 1_000, endAt: 3_000 })
    expect(liveRange({ ...snapshot, retainedFromAt: 2_000 })).toEqual({ startAt: 2_000, endAt: 3_000 })
  })

  test("maps every owner family to a stable user-facing group", () => {
    expect(ownerGroup("renderer")).toBe("Desktop / Electron")
    expect(ownerGroup("runtime")).toBe("Claxedo server and workspace activity")
    expect(ownerGroup("harness")).toBe("Harnesses and CLI")
    expect(ownerGroup("mcp")).toBe("MCP")
    expect(ownerGroup("pty")).toBe("Terminals and shell tools")
  })
})

function point(at: number, processId: string, cpu: number, rssBytes: number) {
  return {
    at,
    processId,
    cpuMachinePercent: { state: "available", value: cpu },
    rssBytes: { state: "available", value: rssBytes },
  } as const
}
