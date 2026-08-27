import { expect, test } from "bun:test"
import {
  browserScenarioFailure,
  changedFilesForVcs,
  claxedoStateSeed,
  diagnosticsPairModeOrder,
  fixtureFor,
  mergeDiagnosticsRuns,
  missingSessionMessageRequest,
} from "../src/browser-runner"
import { scenarioIds } from "../src/cli-options"
import {
  FRAME_120HZ_MS,
  FRAME_60HZ_MS,
  buildFrameMetric,
  frameVerdict,
  mergeFrameMetrics,
  type FrameMetric,
} from "../src/frame-sampler"
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

test("mergeFrameMetrics calculates p95 and deadline counts from the pooled interval population", () => {
  const merged = mergeFrameMetrics("flow", [
    frame({
      p95FrameMs: 40,
      worstFrameMs: 40,
      framesOver833: 1,
      framesOver1667: 1,
      sampleCount: 2,
      frameIntervalsMs: [4, 40],
    }),
    frame({
      p95FrameMs: 6,
      worstFrameMs: 6,
      sampleCount: 38,
      frameIntervalsMs: Array.from({ length: 38 }, () => 6),
    }),
  ])
  expect(merged.p95FrameMs).toBe(6)
  expect(merged.worstFrameMs).toBe(40)
  expect(merged.framesOver1667).toBe(1)
  expect(merged.sampleCount).toBe(40)
  expect(merged.verdict).toBe("red")
  expect(merged.runs).toHaveLength(2)
})

test("long-animation frames replace long rAF gaps without double-counting the interval population", () => {
  const metric = buildFrameMetric("flow", [0, 4, 5, 6, 80], [80], 100)
  expect(metric.worstFrameMs).toBe(80)
  expect(metric.p95FrameMs).toBe(80)
  expect(metric.framesOver1667).toBe(1)
  expect(metric.sampleCount).toBe(5)
  expect(metric.longAnimationFrameMs).toEqual([80])
  expect(metric.unattributedSchedulingGapsMs).toEqual([])
  expect(metric.verdict).toBe("red")
})

test("unattributed host scheduling pauses warn without failing the application gate", () => {
  const metric = buildFrameMetric("flow", [4, 120, 6], [], 130)
  expect(metric.frameIntervalsMs).toEqual([4, 6])
  expect(metric.unattributedSchedulingGapsMs).toEqual([120])
  expect(metric.worstFrameMs).toBe(6)
  expect(metric.framesOver1667).toBe(0)
  expect(metric.verdict).toBe("green")
  expect(gateHeadline(metric, { scenario: "session-switch" })).toEqual({
    status: "warn",
    failures: [],
    warnings: [expect.stringContaining("host/browser scheduling")],
  })
})

test("headless rAF cadence above 16.67ms is not blamed on the app while the event loop stays available", () => {
  const frames = Array.from({ length: 8 }, (_, index) => ({ startTime: index * 17.8, duration: 17.8 }))
  const heartbeat = Array.from({ length: 18 }, (_, index) => ({ startTime: index * 8, duration: 8 }))
  const metric = buildFrameMetric("blank", frames, [], 142.4, undefined, heartbeat)

  expect(metric.observedFrameIntervalsMs).toEqual(Array.from({ length: 8 }, () => 17.8))
  expect(metric.frameIntervalsMs).toEqual([])
  expect(metric.unattributedSchedulingGapsMs).toEqual(Array.from({ length: 8 }, () => 17.8))
  expect(metric.framesOver1667).toBe(0)
  expect(metric.verdict).toBe("green")
})

test("a deadline rAF gap remains gated when the heartbeat proves main-thread unavailability", () => {
  const metric = buildFrameMetric(
    "interaction",
    [{ startTime: 0, duration: 18 }],
    [],
    18,
    undefined,
    [{ startTime: 0, duration: 18 }],
  )

  expect(metric.frameIntervalsMs).toEqual([18])
  expect(metric.unattributedSchedulingGapsMs).toEqual([])
  expect(metric.framesOver1667).toBe(1)
  expect(metric.verdict).toBe("red")
})

test("renderer tasks, rather than timer cadence, own the browser 60hz gate when a trace is available", () => {
  const metric = buildFrameMetric(
    "interaction",
    [{ startTime: 0, duration: 30.5 }],
    [],
    30.5,
    undefined,
    [{ startTime: 0, duration: 32 }],
    [2.4, 14.8, 3.1],
  )

  expect(metric.mainThreadTasksMs).toEqual([2.4, 14.8, 3.1])
  expect(metric.frameIntervalsMs).toEqual([2.4, 14.8, 3.1])
  expect(metric.unattributedSchedulingGapsMs).toEqual([30.5])
  expect(metric.worstFrameMs).toBe(14.8)
  expect(metric.framesOver1667).toBe(0)
  expect(metric.verdict).toBe("amber")
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

test("renderer intervals over the 60hz deadline fail the gate", () => {
  const { status, failures } = gateHeadline(frame({ p95FrameMs: 20, worstFrameMs: 40, framesOver1667: 8 }), { scenario: "session-switch" })
  expect(status).toBe("fail")
  expect(failures.length).toBeGreaterThan(0)
})

test("launch flows enforce the same renderer frame floor as interactions", () => {
  const dropped = frame({ p95FrameMs: 0.2, worstFrameMs: 212, framesOver1667: 4 })
  const launch = gateHeadline(dropped, { scenario: "launch-project" })
  expect(launch.status).toBe("fail")
  expect(launch.failures).toHaveLength(2)

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
  const physicallySlow = gatePairedHeadline(
    frame({ p95FrameMs: 80, worstFrameMs: 90 }),
    frame({ p95FrameMs: 81, worstFrameMs: 94 }),
    { scenario: "session-switch", worst_frame_ms: 100 },
  )
  expect(physicallySlow.failures).toEqual([])
  expect(physicallySlow.warnings).toContainEqual(expect.stringContaining("disabled control base-app gate"))
  expect(gatePairedHeadline(
    frame({ p95FrameMs: 5, worstFrameMs: 10 }),
    frame({ p95FrameMs: 8, worstFrameMs: 16 }),
    { scenario: "session-switch", worst_frame_ms: 100 },
  ).failures).toEqual([
    expect.stringContaining("moved p95"),
    expect.stringContaining("moved worst"),
  ])
})

test("paired diagnostics gate only attributes a stored-budget crossing to diagnostics", () => {
  expect(gatePairedHeadline(
    frame({ worstFrameMs: 11 }),
    frame({ worstFrameMs: 16 }),
    { scenario: "session-switch", worst_frame_ms: 12 },
  ).failures).toContainEqual(expect.stringContaining("moved worst frame past budget"))

  const alreadyRegressed = gatePairedHeadline(
    frame({ worstFrameMs: 14 }),
    frame({ worstFrameMs: 15 }),
    { scenario: "session-switch", worst_frame_ms: 12 },
  )
  expect(alreadyRegressed.failures).toEqual([])
  expect(alreadyRegressed.warnings).toContainEqual(expect.stringContaining("disabled control already exceeds"))
})

test("paired diagnostics gate leaves the absolute renderer floor to the base-app gate", () => {
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
  expect(diagnosticsCrossing.warnings).toContainEqual(expect.stringContaining("disabled control base-app gate"))
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
  expect(state.workspacePanel).toEqual({
    open: false,
    mode: "review",
    workspaceDir: "/tmp/claxedo-perf/live-terminal-switch",
  })
})

test("diagnostic message scale reaches the browser fixture without a hidden minimum", () => {
  const fixture = fixtureFor("session-switch", {
    repos: 1,
    sessions: 2,
    messages: 1,
    terminals: 0,
    changed_files: 0,
    projects: 1,
    themes: ["claxedo-dark"],
    agent_actions: 0,
    mask_keys: [],
  })

  expect(fixture.totalMessages).toBe(1)
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
