import { expect, test } from "bun:test"
import {
  browserScenarioFailure,
  changedFilesForVcs,
  claxedoStateSeed,
  diagnosticsPairModeOrder,
  mergeDiagnosticsRuns,
  missingSessionMessageRequest,
} from "../src/browser-runner"
import { scenarioIds } from "../src/cli-options"
import { FRAME_120HZ_MS, FRAME_60HZ_MS, frameVerdict, mergeFrameMetrics, type FrameMetric } from "../src/frame-sampler"
import { applyBudget, gateDiagnostics, gateHeadline, gatePairedHeadline } from "../src/report"

function frame(overrides: Partial<FrameMetric>): FrameMetric {
  return {
    label: "test",
    worstFrameMs: 5,
    p95FrameMs: 5,
    framesOver833: 0,
    framesOver1667: 0,
    sampleCount: 60,
    completionMs: 100,
    verdict: "green",
    ...overrides,
  }
}

test("frameVerdict maps p95 frame time to a refresh rate", () => {
  expect(frameVerdict(FRAME_120HZ_MS - 1)).toBe("green")
  expect(frameVerdict(FRAME_120HZ_MS + 2)).toBe("amber")
  expect(frameVerdict(FRAME_60HZ_MS + 2)).toBe("red")
})

test("mergeFrameMetrics keeps the worst case across iterations", () => {
  const merged = mergeFrameMetrics("flow", [
    frame({ worstFrameMs: 9, p95FrameMs: 7 }),
    frame({ worstFrameMs: 22, p95FrameMs: 19, framesOver1667: 4 }),
  ])
  expect(merged.worstFrameMs).toBe(22)
  expect(merged.p95FrameMs).toBe(19)
  expect(merged.verdict).toBe("red")
})

test("a smooth headline passes the 120hz gate", () => {
  const { status, failures, warnings } = gateHeadline(frame({ p95FrameMs: 6, worstFrameMs: 9 }), { scenario: "session-switch" })
  expect(status).toBe("pass")
  expect(failures).toEqual([])
  expect(warnings).toEqual([])
})

test("a below-120hz-but-above-60hz headline warns, does not fail", () => {
  const { status, warnings, failures } = gateHeadline(frame({ p95FrameMs: 12, worstFrameMs: 14 }), { scenario: "session-switch" })
  expect(status).toBe("warn")
  expect(failures).toEqual([])
  expect(warnings.length).toBe(1)
})

test("sustained sub-60hz frames fail the gate", () => {
  const { status, failures } = gateHeadline(frame({ p95FrameMs: 20, worstFrameMs: 40, framesOver1667: 8 }), { scenario: "session-switch" })
  expect(status).toBe("fail")
  expect(failures.length).toBeGreaterThan(0)
})

test("launch flows warn (not fail) on dropped frames, since they are load events", () => {
  const dropped = frame({ p95FrameMs: 0.2, worstFrameMs: 212, framesOver1667: 4 })
  const launch = gateHeadline(dropped, { scenario: "launch-project" })
  expect(launch.status).toBe("warn")
  expect(launch.failures).toEqual([])

  const interaction = gateHeadline(dropped, { scenario: "session-switch" })
  expect(interaction.status).toBe("fail")
})

test("a worst-frame regression past the budget fails even when smooth", () => {
  const result = applyBudget(
    {
      adapter: "browser",
      target: "claxedo",
      id: "large-diff-toggle",
      name: "Large diff",
      started_at: new Date(0).toISOString(),
      duration_ms: 1,
      seed: { repos: 1, sessions: 0, messages: 0, terminals: 0, changed_files: 0, projects: 1, themes: [], agent_actions: 0, mask_keys: [] },
      headline: frame({ p95FrameMs: 6, worstFrameMs: 30 }),
      metrics: [],
    },
    { scenario: "large-diff-toggle", worst_frame_ms: 20 },
  )
  expect(result.status).toBe("fail")
  expect(result.failures.some((failure) => failure.includes("regressed past budget"))).toBe(true)
})

test("diagnostics evidence requires retained samples from a real process tree", () => {
  expect(gateDiagnostics({
    retainedBytes: 1_024,
    retainedProcesses: 2,
    droppedTicks: 0,
    maxSourceDurationMs: 5,
    maxReconciliationDurationMs: 20,
    collections: 2,
    sampleCount: 2,
    controlHeadline: frame({ label: "session-switch" }),
    enabledHeadline: frame({ label: "session-switch" }),
  })).toEqual({ failures: [], warnings: [] })
  expect(gateDiagnostics({
    retainedBytes: 20 * 1024 * 1024 + 1,
    retainedProcesses: 0,
    droppedTicks: 2,
    maxSourceDurationMs: 5,
    maxReconciliationDurationMs: 20,
    collections: 0,
    sampleCount: 0,
    controlHeadline: frame({ label: "control" }),
    enabledHeadline: frame({ label: "enabled" }),
  })).toEqual({
    failures: [
      expect.stringContaining("retained bytes"),
      expect.stringContaining("no real process samples"),
      expect.stringContaining("labels did not match"),
    ],
    warnings: [expect.stringContaining("dropped 2")],
  })
})

test("paired diagnostics gate compares a fresh enabled run to its disabled control", () => {
  expect(gatePairedHeadline(
    frame({ p95FrameMs: 80, worstFrameMs: 90 }),
    frame({ p95FrameMs: 81, worstFrameMs: 94 }),
    { scenario: "session-switch", worst_frame_ms: 100 },
  ).failures).toEqual([])
  expect(gatePairedHeadline(
    frame({ p95FrameMs: 10, worstFrameMs: 20 }),
    frame({ p95FrameMs: 15, worstFrameMs: 30 }),
    { scenario: "session-switch", worst_frame_ms: 100 },
  ).failures).toEqual([
    expect.stringContaining("moved p95"),
    expect.stringContaining("moved worst"),
  ])
})

test("paired diagnostics gate only attributes a stored-budget crossing to diagnostics", () => {
  expect(gatePairedHeadline(
    frame({ worstFrameMs: 110 }),
    frame({ worstFrameMs: 120 }),
    { scenario: "session-switch", worst_frame_ms: 115 },
  ).failures).toContainEqual(expect.stringContaining("moved worst frame past budget"))

  const alreadyRegressed = gatePairedHeadline(
    frame({ worstFrameMs: 160 }),
    frame({ worstFrameMs: 158 }),
    { scenario: "session-switch", worst_frame_ms: 115 },
  )
  expect(alreadyRegressed.failures).toEqual([])
  expect(alreadyRegressed.warnings).toContainEqual(expect.stringContaining("disabled control already exceeds"))
})

test("paired diagnostics gate reports base frame failures without a one-frame cliff", () => {
  const baseFailure = gatePairedHeadline(
    frame({ framesOver1667: 3 }),
    frame({ framesOver1667: 3 }),
    { scenario: "session-switch" },
  )
  expect(baseFailure.failures).toEqual([])
  expect(baseFailure.warnings).toContainEqual(expect.stringContaining("disabled control base-app gate"))

  const diagnosticsCrossing = gatePairedHeadline(
    frame({ framesOver1667: 2 }),
    frame({ framesOver1667: 3 }),
    { scenario: "session-switch" },
  )
  expect(diagnosticsCrossing.failures).toEqual([])
})

test("diagnostics pairs counterbalance fresh-browser order and merge conservative evidence", () => {
  expect(diagnosticsPairModeOrder.map((mode) => mode.enabled)).toEqual([false, true, true, false])
  expect(mergeDiagnosticsRuns([
    {
      retainedBytes: 100,
      retainedProcesses: 2,
      droppedTicks: 1,
      maxSourceDurationMs: 3,
      maxReconciliationDurationMs: 4,
      collections: 2,
      sampleCount: 5,
    },
    {
      retainedBytes: 90,
      retainedProcesses: 3,
      droppedTicks: 2,
      maxSourceDurationMs: 6,
      maxReconciliationDurationMs: 5,
      collections: 4,
      sampleCount: 7,
    },
  ])).toEqual({
    retainedBytes: 100,
    retainedProcesses: 3,
    droppedTicks: 3,
    maxSourceDurationMs: 6,
    maxReconciliationDurationMs: 5,
    collections: 6,
    sampleCount: 12,
  })
})

test("browser large-diff summary fixture strips full patch payloads", () => {
  const fixture = {
    changedFiles: [{
      file: "src/generated/file-0.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      patch: "@@ -1 +1 @@",
    }],
  }

  expect(changedFilesForVcs(new URL("http://test/api/claxedo/diff/vcs?content=summary"), fixture)).toEqual([{
    file: "src/generated/file-0.ts",
    status: "modified",
    additions: 2,
    deletions: 1,
  }])
  expect(changedFilesForVcs(new URL("http://test/api/claxedo/diff/vcs"), fixture)[0]).toHaveProperty("patch")
})

test("browser seed exposes live terminals in the Claxedo sidebar inventory", () => {
  const state = claxedoStateSeed({
    directory: "/tmp/claxedo-perf/live-terminal-switch",
    scenario: "live-terminal-switch",
    terminals: [
      { id: "pty_live_1", title: "Terminal 1" },
      { id: "pty_live_2", title: "Terminal 2" },
    ],
  })

  expect(state.workbench.contentIds).toEqual(["terminal_perf_0", "terminal_perf_1"])
  expect(state.workbench.panes).toEqual([{ id: "pane_perf_terminal", contentId: "terminal_perf_0" }])
  expect(state.meta.terminal_perf_0?.terminalId).toBe("pty_live_1")
  expect(state.meta.terminal_perf_0?.content?.title).toBe("Terminal 1")
  expect(state.terminal.owner.pty_live_1).toBe("terminal_perf_0")
  expect(state.terminal.agentStatus.pty_live_1).toBe("idle")
})

test("browser validation accepts visibly rendered session transcript without legacy message request", () => {
  expect(missingSessionMessageRequest("large-diff-toggle", {
    requestCounts: {
      messages: 0,
      expectedTranscripts: { ses_perf_0: "Large diff" },
      visibleTranscripts: { ses_perf_0: true },
    },
  })).toBe(false)

  expect(missingSessionMessageRequest("large-diff-toggle", {
    requestCounts: {
      messages: 0,
      expectedTranscripts: { ses_perf_0: "Large diff" },
      visibleTranscripts: {},
    },
  })).toBe(true)
})

test("explicit scenario selection wins over --all", () => {
  expect(scenarioIds(["run", "--all", "--scenario", "large-diff-toggle"])).toEqual(["large-diff-toggle"])
  expect(scenarioIds(["run", "--all"]).length).toBeGreaterThan(1)
  expect(scenarioIds(["run"])).toEqual(["launch-project"])
})

test("browser scenario crashes are reportable failed rows", () => {
  const result = browserScenarioFailure({
    scenario: "large-diff-toggle",
    browserVersion: "test-browser",
    app: { baseUrl: "http://127.0.0.1:4444", mockPort: 4445 },
    error: new Error("useful screen timed out"),
  })

  expect(result.status).toBe("fail")
  expect(result.metrics).toEqual([])
  expect(result.headline.verdict).toBe("red")
  expect(result.failures).toEqual(["browser scenario crashed: useful screen timed out"])
  expect(result.attribution?.browser?.version).toBe("test-browser")
  expect(result.attribution?.server?.base_url).toBe("http://127.0.0.1:4444")
})
