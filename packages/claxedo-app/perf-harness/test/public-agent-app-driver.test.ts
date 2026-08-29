import { describe, expect, test } from "bun:test"
import { createClaxedoPublicDriver } from "../src/public-agent-app-driver"
import {
  runPrearmedStablePaint,
  waitForPanelOwner,
} from "../src/public-workspace-panel"

const receipt = {
  endpoint: "correct-content-painted-and-input-ready" as const,
  checks: [
    { id: "content-identity", passed: true },
    { id: "first-fold-painted", passed: true },
    { id: "two-presentations", passed: true },
    { id: "trusted-input", passed: true },
  ],
}

function harness() {
  const activations: string[] = []
  const launches: Array<{ stateHandle: string; initialSessionId: string }> = []
  const navigationExecutions: Array<Record<string, unknown>> = []
  const panelV1Executions: Array<Record<string, unknown>> = []
  const panelV2Executions: Array<Record<string, unknown>> = []
  let clock = 10
  const target = (logicalSessionId: string, sessionId: string) => ({
    logicalSessionId,
    workspaceDirectory: "/tmp/workspace",
    sessionId,
    title: logicalSessionId,
    expectedMessageIds: [`message-${logicalSessionId}`],
    expectedContentSha256: {},
    expectedTextPartSha256: {},
    expectedPartIds: [],
  })
  const readinessTargets = new Map([
    ["control", target("control", "native-control")],
    ["within-workspace-cold-1048576", target("within-workspace-cold-1048576", "native-cold")],
    ["within-workspace-warm-1048576", target("within-workspace-warm-1048576", "native-warm")],
    ["source", target("source", "native-source")],
    ["destination", target("destination", "native-destination")],
  ])
  const driver = createClaxedoPublicDriver({
    hello: { protocolVersion: 1 },
    prepare: async () => ({
      materialization: {
        corpusDigestSha256: "a".repeat(64),
        eventSchemaDigestSha256: "b".repeat(64),
        mappingDigestSha256: "c".repeat(64),
        sessionMapping: { control: "native-control" },
        readinessTargets,
        messageCount: 6,
        transcriptBytes: 12,
      },
      stateHandles: { P0: "sealed-p0", P1: "sealed-p1" },
    }),
    launch: async (stateHandle, initialSessionId) => {
      launches.push({ stateHandle, initialSessionId })
      return {
        processes: [{ pid: 21, startTimeMs: 1_000, owner: "application", category: "claxedo-root" }],
        readiness: receipt,
        clock: { kind: "single-monotonic-clock", clock: "test", start: 1, end: 5 },
      }
    },
    activate: async (target) => {
      activations.push(target.logicalSessionId)
      const start = clock
      clock += 2
      return { kind: "single-monotonic-clock", clock: "test-renderer", start, end: clock }
    },
    executeSessionNavigation: async (benchmarkCase, source, destination, preset) => {
      navigationExecutions.push({ benchmarkCase, source, destination, preset })
      return measurement()
    },
    executePanelAction: async (benchmarkCase, target) => {
      panelV1Executions.push({ benchmarkCase, target })
      return measurement()
    },
    executePanelActionV2: async (benchmarkCase, target, preset) => {
      panelV2Executions.push({ benchmarkCase, target, preset })
      return measurement()
    },
    shutdown: async () => ({ terminated: [], survivors: [] }),
  })
  return { driver, activations, launches, navigationExecutions, panelV1Executions, panelV2Executions }
}

function measurement() {
  return {
    clock: { kind: "single-monotonic-clock" as const, clock: "performance.now" as const, start: 20, end: 25 },
    rendererTrace: {
      clock: "performance.now" as const,
      transitionMode: "animated" as const,
      milestones: [],
      frameTimestampsMs: [],
      longAnimationFrames: [],
      counterInterval: { start: 20, end: 25 },
      counters: { scriptDurationMs: 0, styleRecalcDurationMs: 0, layoutDurationMs: 0, taskDurationMs: 0 },
    },
  }
}

const workspaceFixtureManifest = {
  schemaVersion: 1,
  generator: "agent-app-workspace-v1",
  seed: "test",
  load: {
    directoryCount: 16,
    sourceFileCount: 24,
    sourceFileBytes: 1024,
    changedFileCount: 24,
    diffHunksPerFile: 1,
    diffLinesPerHunk: 1,
    openFileTabCount: 4,
  },
  directories: Array.from({ length: 16 }, (_, index) => `src/section-${index}`),
  files: Array.from({ length: 24 }, (_, index) => ({
    path: `src/section-${index % 16}/file-${index}.ts`,
    byteLength: 1024,
    changed: true,
    hunks: [{ startLine: 1, lineCount: 1 }],
    initialDigestSha256: "a".repeat(64),
    currentDigestSha256: "b".repeat(64),
  })),
  changedFilePaths: Array.from({ length: 24 }, (_, index) => `src/section-${index % 16}/file-${index}.ts`),
  openFilePaths: Array.from({ length: 4 }, (_, index) => `src/section-${index}/file-${index}.ts`),
  manifestDigestSha256: "c".repeat(64),
}

const panelScenarioDefinition = {
  cases: {
    panelLoads: [
      { id: "light", expandedDirectoryCount: 2, retainedFileTabCount: 2, expandedReviewFileCount: 1 },
      { id: "moderate", expandedDirectoryCount: 8, retainedFileTabCount: 3, expandedReviewFileCount: 6 },
      { id: "heavy", expandedDirectoryCount: 16, retainedFileTabCount: 4, expandedReviewFileCount: 24 },
    ],
  },
}

async function prepare(driver: ReturnType<typeof createClaxedoPublicDriver>) {
  return driver.prepare({
    scenarioId: "session-switch-v001",
    scenarioDigestSha256: "1".repeat(64),
    corpusDirectory: "/tmp/corpus",
    corpusManifestPath: "/tmp/corpus/manifest.json",
    corpusDigestSha256: "a".repeat(64),
    corpusDefinitionDigestSha256: "2".repeat(64),
    eventSchemaDigestSha256: "b".repeat(64),
    runDirectory: "/tmp/run",
  })
}

describe("Claxedo public driver", () => {
  test("attests to the native OpenCode path and sealed P0/P1 states", async () => {
    const { driver } = harness()
    const result = await prepare(driver)
    expect(result.materializationMode).toBe("native-opencode")
    expect(result.stateHandles).toEqual({ P0: "sealed-p0", P1: "sealed-p1" })
  })

  test("enforces cold and warm preparation around exactly one measured activation", async () => {
    const { driver, activations } = harness()
    await prepare(driver)
    await driver.launch({
      scenarioId: "session-switch-v001",
      stateHandle: "sealed-p1",
      initialSessionId: "control",
      groupId: "group",
    })
    const cold = await driver.execute({
      scenarioId: "session-switch-v001",
      case: {
        caseId: "cold",
        workload: "isolated-latency",
        sessionState: "cold",
        sourceSessionId: "control",
        destinationSessionId: "within-workspace-cold-1048576",
      },
    })
    const warm = await driver.execute({
      scenarioId: "session-switch-v001",
      case: {
        caseId: "warm",
        workload: "isolated-latency",
        sessionState: "warm",
        sourceSessionId: "control",
        destinationSessionId: "within-workspace-warm-1048576",
      },
    })
    expect(activations).toEqual([
      "control",
      "within-workspace-cold-1048576",
      "within-workspace-warm-1048576",
      "control",
      "within-workspace-warm-1048576",
    ])
    expect(cold.durationMs).toBe(2)
    expect(warm.durationMs).toBe(2)
  })

  test("measures application start from the requested exact state", async () => {
    const { driver, launches } = harness()
    await prepare(driver)
    const result = await driver.execute({
      scenarioId: "app-start-v001",
      stateHandle: "sealed-p0",
      case: { caseId: "new-start", startMode: "new-application-state" },
    })
    expect(launches).toEqual([{ stateHandle: "sealed-p0", initialSessionId: "control" }])
    expect(result.durationMs).toBe(4)
  })

  test("dispatches session-navigation cases with the authoritative panel preset", async () => {
    const { driver, navigationExecutions } = harness()
    await driver.prepare({
      scenarioId: "session-navigation-v001",
      scenarioDigestSha256: "1".repeat(64),
      corpusDirectory: "/tmp/corpus",
      corpusManifestPath: "/tmp/corpus/manifest.json",
      corpusDigestSha256: "a".repeat(64),
      corpusDefinitionDigestSha256: "2".repeat(64),
      eventSchemaDigestSha256: "b".repeat(64),
      runDirectory: "/tmp/run",
      scenarioDefinition: panelScenarioDefinition,
      workspaceFixtureManifest: workspaceFixtureManifest as never,
    })
    await driver.launch({
      scenarioId: "session-navigation-v001",
      stateHandle: "sealed-p1",
      initialSessionId: "control",
      groupId: "group",
    })
    const result = await driver.execute({
      scenarioId: "session-navigation-v001",
      case: {
        caseId: "return-open",
        workload: "session-navigation",
        trend: "panel-load",
        navigationType: "return-visited-panel-open",
        transcriptBytes: 1_048_576,
        loadProfile: "moderate",
        sourceSessionId: "source",
        destinationSessionId: "destination",
      },
    })
    expect(result.durationMs).toBe(5)
    expect(result.timingEvidence).toEqual({ trustedInputAt: 20, trustedInputEvent: "pointerdown" })
    expect(navigationExecutions).toHaveLength(1)
    expect(navigationExecutions[0]?.preset).toEqual(panelScenarioDefinition.cases.panelLoads[1])
  })

  test("allows return after a prior first-visit even when other first-visits intervene", async () => {
    const { driver, navigationExecutions } = harness()
    await driver.prepare({
      scenarioId: "session-navigation-v001",
      scenarioDigestSha256: "1".repeat(64),
      corpusDirectory: "/tmp/corpus",
      corpusManifestPath: "/tmp/corpus/manifest.json",
      corpusDigestSha256: "a".repeat(64),
      corpusDefinitionDigestSha256: "2".repeat(64),
      eventSchemaDigestSha256: "b".repeat(64),
      runDirectory: "/tmp/run",
      scenarioDefinition: panelScenarioDefinition,
      workspaceFixtureManifest: workspaceFixtureManifest as never,
    })
    await driver.launch({
      scenarioId: "session-navigation-v001",
      stateHandle: "sealed-p1",
      initialSessionId: "control",
      groupId: "group",
    })
    const common = {
      workload: "session-navigation" as const,
      trend: "history-size" as const,
      transcriptBytes: 1_048_576,
      sourceSessionId: "source",
    }
    await driver.execute({
      scenarioId: "session-navigation-v001",
      case: { ...common, caseId: "first-a", navigationType: "first-visit", destinationSessionId: "destination" },
    })
    await driver.execute({
      scenarioId: "session-navigation-v001",
      case: {
        ...common,
        caseId: "first-b",
        navigationType: "first-visit",
        destinationSessionId: "within-workspace-warm-1048576",
        transcriptBytes: 2_097_152,
      },
    })
    const returned = await driver.execute({
      scenarioId: "session-navigation-v001",
      case: { ...common, caseId: "return-a", navigationType: "return-visited-panel-closed", destinationSessionId: "destination" },
    })

    expect(navigationExecutions.map((item) =>
      (item.benchmarkCase as { navigationType: string }).navigationType)).toEqual([
      "first-visit",
      "first-visit",
      "return-visited-panel-closed",
    ])
    expect(returned.timingEvidence).toEqual({ trustedInputAt: 20, trustedInputEvent: "pointerdown" })
  })

  test("rejects a return without a prior first-visit in this process", async () => {
    const { driver, navigationExecutions } = harness()
    await driver.prepare({
      scenarioId: "session-navigation-v001",
      scenarioDigestSha256: "1".repeat(64),
      corpusDirectory: "/tmp/corpus",
      corpusManifestPath: "/tmp/corpus/manifest.json",
      corpusDigestSha256: "a".repeat(64),
      corpusDefinitionDigestSha256: "2".repeat(64),
      eventSchemaDigestSha256: "b".repeat(64),
      runDirectory: "/tmp/run",
      scenarioDefinition: panelScenarioDefinition,
      workspaceFixtureManifest: workspaceFixtureManifest as never,
    })
    await driver.launch({
      scenarioId: "session-navigation-v001",
      stateHandle: "sealed-p1",
      initialSessionId: "control",
      groupId: "group",
    })
    await expect(driver.execute({
      scenarioId: "session-navigation-v001",
      case: {
        caseId: "orphan-return",
        workload: "session-navigation",
        trend: "history-size",
        navigationType: "return-visited-panel-closed",
        transcriptBytes: 1_048_576,
        sourceSessionId: "source",
        destinationSessionId: "destination",
      },
    })).rejects.toThrow("prior first-visit of the destination in this process")
    expect(navigationExecutions).toHaveLength(0)
  })

  test("dispatches workspace-panel-v001 actions with the requested authoritative preset", async () => {
    const { driver, panelV2Executions } = harness()
    await driver.prepare({
      scenarioId: "workspace-panel-v001",
      scenarioDigestSha256: "1".repeat(64),
      corpusDirectory: "/tmp/corpus",
      corpusManifestPath: "/tmp/corpus/manifest.json",
      corpusDigestSha256: "a".repeat(64),
      corpusDefinitionDigestSha256: "2".repeat(64),
      eventSchemaDigestSha256: "b".repeat(64),
      runDirectory: "/tmp/run",
      scenarioDefinition: panelScenarioDefinition,
      workspaceFixtureManifest: workspaceFixtureManifest as never,
    })
    await driver.launch({
      scenarioId: "workspace-panel-v001",
      stateHandle: "sealed-p1",
      initialSessionId: "control",
      groupId: "group",
    })
    const result = await driver.execute({
      scenarioId: "workspace-panel-v001",
      case: {
        caseId: "review-to-files-heavy",
        workload: "workspace-panel-interaction",
        action: "review-to-files",
        loadProfile: "heavy",
      },
    })
    expect(panelV2Executions).toHaveLength(1)
    expect(panelV2Executions[0]?.preset).toEqual(panelScenarioDefinition.cases.panelLoads[2])
    expect(result.timingEvidence).toEqual({ trustedInputAt: 20, trustedInputEvent: "pointerdown" })
  })


  test("arms V2 readiness before click and returns its exact stable-paint timestamp", async () => {
    const order: string[] = []
    let paint: ((at: number) => void) | undefined
    const paintedAt = await runPrearmedStablePaint({
      arm: () => {
        order.push("armed")
        return new Promise<number>((resolve) => { paint = resolve })
      },
      click: async () => {
        order.push("click")
        paint?.(37)
      },
      cancel: async () => { order.push("cancel") },
    })

    expect(order).toEqual(["armed", "click"])
    expect(paintedAt).toBe(37)
  })

  test("requires the same panel-owner signature on consecutive readiness frames", async () => {
    const original = new Map<string, PropertyDescriptor | undefined>()
    const replaceGlobal = (name: string, value: unknown) => {
      original.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
    }
    const closedShell = {
      dataset: { open: "false", stateOpen: "false" },
      getBoundingClientRect: () => ({ left: 1000 }),
      querySelectorAll: () => [],
    }
    const shells = [closedShell, null, closedShell, null, null]
    let frameCount = 0
    replaceGlobal("window", globalThis)
    replaceGlobal("innerWidth", 1000)
    replaceGlobal("document", {
      querySelector: () => shells[Math.min(frameCount - 1, shells.length - 1)],
    })
    replaceGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frameCount += 1
      queueMicrotask(() => callback(frameCount))
      return frameCount
    })
    replaceGlobal("cancelAnimationFrame", () => undefined)
    try {
      const page = {
        evaluate: async (callback: (argument: unknown) => unknown, argument: unknown) => callback(argument),
      }
      const at = await waitForPanelOwner(
        page as never,
        "closed",
        {
          sessionId: "session-a",
          logicalSessionId: "session-a",
          workspaceDirectory: "/workspace",
          title: "Session A",
          expectedMessageIds: [],
          expectedContentSha256: {},
          expectedTextPartSha256: {},
          expectedPartIds: [],
        },
        { manifest: {} as never, files: ["src/a.ts"], changed: ["src/a.ts"], openFiles: ["src/a.ts", "src/b.ts"] },
        { markEnd: false },
      )

      expect(at).toBe(5)
      expect(frameCount).toBe(5)
    } finally {
      for (const [name, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else delete (globalThis as Record<string, unknown>)[name]
      }
    }
  })

  test("rejects a panel scenario that does not define all authoritative presets", async () => {
    const { driver } = harness()
    await expect(driver.prepare({
      scenarioId: "workspace-panel-v001",
      scenarioDigestSha256: "1".repeat(64),
      corpusDirectory: "/tmp/corpus",
      corpusManifestPath: "/tmp/corpus/manifest.json",
      corpusDigestSha256: "a".repeat(64),
      corpusDefinitionDigestSha256: "2".repeat(64),
      eventSchemaDigestSha256: "b".repeat(64),
      runDirectory: "/tmp/run",
      scenarioDefinition: { cases: { panelLoads: panelScenarioDefinition.cases.panelLoads.slice(0, 2) } },
      workspaceFixtureManifest: workspaceFixtureManifest as never,
    })).rejects.toThrow("must define light, moderate, and heavy")
  })
})
