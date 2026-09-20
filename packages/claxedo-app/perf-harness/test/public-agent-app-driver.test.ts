import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { buildWorkspaceFixtureManifest } from "agent-app-benchmark/workspace-fixture"
import type { WorkspaceLoad } from "agent-app-benchmark/driver-sdk"
import { createClaxedoPublicDriver, PUBLIC_SCENARIO_IDS } from "../src/public-agent-app-driver"
import {
  runPrearmedStablePaint,
  waitForPanelOwner,
  WORKSPACE_PANEL_ACTIONS,
  type WorkspacePanelCase,
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

function harness(extraSessionIds: string[] = []) {
  const activations: string[] = []
  const launches: Array<{ stateHandle: string; initialSessionId: string }> = []
  const navigationExecutions: Array<Record<string, unknown>> = []
  const panelExecutions: Array<Record<string, unknown>> = []
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
  for (const id of extraSessionIds) readinessTargets.set(id, target(id, `native-${id}`))
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
    executePanelAction: async (benchmarkCase, target, preset) => {
      panelExecutions.push({ benchmarkCase, target, preset })
      return measurement()
    },
    shutdown: async () => ({ terminated: [], survivors: [] }),
  })
  return { driver, activations, launches, navigationExecutions, panelExecutions }
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

// Resolve the installed package so dependency drift cannot be hidden by a local
// reproduction of its fixtures or scheduler. The framework owns these cases.
const frameworkRoot = new URL("../", import.meta.resolve("agent-app-benchmark/driver-sdk"))
type Scenario = {
  id: string
  kind: string
  cases: {
    workspaceLoad?: WorkspaceLoad
    panelLoads?: Array<{
      id: string
      expandedDirectoryCount: number
      retainedFileTabCount: number
      expandedReviewFileCount: number
    }>
    actions?: string[]
  }
}
const readScenario = async (id: string): Promise<Scenario> =>
  JSON.parse(await readFile(new URL(`registry/scenarios/${id}.json`, frameworkRoot), "utf8"))
type DriverCase = Parameters<ReturnType<typeof createClaxedoPublicDriver>["execute"]>[0]["case"]
const { expandCases, buildResourceSequence } = (await import(new URL("src/cases.mjs", frameworkRoot).href)) as {
  expandCases: (scenario: Scenario, profile: string) => DriverCase[]
  buildResourceSequence: (scenario: Scenario) => DriverCase[]
}
const panelScenarioDefinition = await readScenario("workspace-panel-v1")
// The panel scenario is the one that exercises a materialized workspace, so a
// missing workspaceLoad means the registry changed under the test rather than
// that this case is optional here.
const panelWorkspaceLoad = panelScenarioDefinition.cases.workspaceLoad
if (!panelWorkspaceLoad) throw new Error("workspace-panel-v1 must define cases.workspaceLoad")
const workspaceFixtureManifest = buildWorkspaceFixtureManifest(panelWorkspaceLoad, "test")

async function prepare(
  driver: ReturnType<typeof createClaxedoPublicDriver>,
  scenarioId = "session-switch-v1",
  scenarioDefinition?: Scenario,
) {
  return driver.prepare({
    scenarioId,
    scenarioDefinition,
    ...(scenarioDefinition?.cases.workspaceLoad ? { workspaceFixtureManifest } : {}),
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
  test("advertises exactly the scenarios registered by the pinned framework", async () => {
    const app: { scenarios: string[]; materializationModes: string[] } = JSON.parse(
      await readFile(new URL("registry/apps/claxedo.json", frameworkRoot), "utf8"),
    )
    const advertised: string[] = [...PUBLIC_SCENARIO_IDS]
    expect(advertised.sort()).toEqual([...app.scenarios].sort())
    expect(app.materializationModes).toContain("native-opencode")
  })

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
      scenarioId: "session-switch-v1",
      stateHandle: "sealed-p1",
      initialSessionId: "control",
      groupId: "group",
    })
    const cold = await driver.execute({
      scenarioId: "session-switch-v1",
      case: {
        caseId: "cold",
        workload: "isolated-latency",
        sessionState: "cold",
        sourceSessionId: "control",
        destinationSessionId: "within-workspace-cold-1048576",
      },
    })
    const warm = await driver.execute({
      scenarioId: "session-switch-v1",
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
    await prepare(driver, "app-start-v1")
    const result = await driver.execute({
      scenarioId: "app-start-v1",
      stateHandle: "sealed-p0",
      case: { caseId: "new-start", startMode: "new-application-state" },
    })
    expect(launches).toEqual([{ stateHandle: "sealed-p0", initialSessionId: "control" }])
    expect(result.durationMs).toBe(4)
  })

  test("dispatches session-navigation cases with the authoritative panel preset", async () => {
    const { driver, navigationExecutions } = harness()
    await driver.prepare({
      scenarioId: "session-navigation-v1",
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
      scenarioId: "session-navigation-v1",
      stateHandle: "sealed-p1",
      initialSessionId: "control",
      groupId: "group",
    })
    const result = await driver.execute({
      scenarioId: "session-navigation-v1",
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
    expect(navigationExecutions[0]?.preset).toEqual(panelScenarioDefinition.cases.panelLoads![1])
  })

  test("allows return after a prior first-visit even when other first-visits intervene", async () => {
    const { driver, navigationExecutions } = harness()
    await driver.prepare({
      scenarioId: "session-navigation-v1",
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
      scenarioId: "session-navigation-v1",
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
      scenarioId: "session-navigation-v1",
      case: { ...common, caseId: "first-a", navigationType: "first-visit", destinationSessionId: "destination" },
    })
    await driver.execute({
      scenarioId: "session-navigation-v1",
      case: {
        ...common,
        caseId: "first-b",
        navigationType: "first-visit",
        destinationSessionId: "within-workspace-warm-1048576",
        transcriptBytes: 2_097_152,
      },
    })
    const returned = await driver.execute({
      scenarioId: "session-navigation-v1",
      case: {
        ...common,
        caseId: "return-a",
        navigationType: "return-visited-panel-closed",
        destinationSessionId: "destination",
      },
    })

    expect(
      navigationExecutions.map((item) => (item.benchmarkCase as { navigationType: string }).navigationType),
    ).toEqual(["first-visit", "first-visit", "return-visited-panel-closed"])
    expect(returned.timingEvidence).toEqual({ trustedInputAt: 20, trustedInputEvent: "pointerdown" })
  })

  test("rejects a return without a prior first-visit in this process", async () => {
    const { driver, navigationExecutions } = harness()
    await driver.prepare({
      scenarioId: "session-navigation-v1",
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
      scenarioId: "session-navigation-v1",
      stateHandle: "sealed-p1",
      initialSessionId: "control",
      groupId: "group",
    })
    await expect(
      driver.execute({
        scenarioId: "session-navigation-v1",
        case: {
          caseId: "orphan-return",
          workload: "session-navigation",
          trend: "history-size",
          navigationType: "return-visited-panel-closed",
          transcriptBytes: 1_048_576,
          sourceSessionId: "source",
          destinationSessionId: "destination",
        },
      }),
    ).rejects.toThrow("prior first-visit of the destination in this process")
    expect(navigationExecutions).toHaveLength(0)
  })

  test("dispatches workspace-panel-v1 actions with the requested authoritative preset", async () => {
    const { driver, panelExecutions } = harness()
    await driver.prepare({
      scenarioId: "workspace-panel-v1",
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
      scenarioId: "workspace-panel-v1",
      stateHandle: "sealed-p1",
      initialSessionId: "control",
      groupId: "group",
    })
    const result = await driver.execute({
      scenarioId: "workspace-panel-v1",
      case: {
        caseId: "review-to-files-heavy",
        workload: "workspace-panel-interaction",
        action: "review-to-files",
        loadProfile: "heavy",
      },
    })
    expect(panelExecutions).toHaveLength(1)
    expect(panelExecutions[0]?.preset).toEqual(panelScenarioDefinition.cases.panelLoads![2])
    expect(result.timingEvidence).toEqual({ trustedInputAt: 20, trustedInputEvent: "pointerdown" })
  })

  test("rejects retired scenario IDs and panel case shapes", async () => {
    const retired = harness()
    await expect(prepare(retired.driver, "workspace-panel-v2")).rejects.toThrow("does not support")
    const { driver, panelExecutions } = harness()
    await prepare(driver, "workspace-panel-v1", panelScenarioDefinition)
    await driver.launch({
      scenarioId: "workspace-panel-v1",
      stateHandle: "sealed-p1",
      initialSessionId: "control",
      groupId: "group",
    })
    await expect(
      driver.execute({
        scenarioId: "workspace-panel-v1",
        case: {
          caseId: "retired",
          workload: "workspace-panel-action",
          action: "open-file",
        } as unknown as WorkspacePanelCase,
      }),
    ).rejects.toThrow("request is incomplete")
    await expect(
      driver.execute({
        scenarioId: "workspace-panel-v1",
        case: {
          caseId: "unknown-action",
          workload: "workspace-panel-interaction",
          action: "toggle-diff-view",
          loadProfile: "light",
        } as unknown as WorkspacePanelCase,
      }),
    ).rejects.toThrow("request is incomplete")
    expect(panelExecutions).toHaveLength(0)
  })

  test("dispatches every case emitted by the installed framework for every advertised scenario", async () => {
    for (const scenarioId of PUBLIC_SCENARIO_IDS) {
      const scenario = await readScenario(scenarioId)
      const cases = [
        ...expandCases(scenario, "smoke"),
        ...(scenario.kind === "session-switch" ? buildResourceSequence(scenario) : []),
      ]
      expect(cases.length).toBeGreaterThan(0)
      const ids = cases.flatMap((item) => ("destinationSessionId" in item ? [item.destinationSessionId] : []))
      const { driver, panelExecutions, navigationExecutions } = harness(ids)
      expect((await driver.hello()).scenarios).toEqual([...PUBLIC_SCENARIO_IDS])
      await prepare(driver, scenarioId, scenario)
      if (scenarioId !== "app-start-v1") {
        await driver.launch({ scenarioId, stateHandle: "sealed-p1", initialSessionId: "control", groupId: "group" })
      }
      for (const benchmarkCase of cases) {
        const stateHandle =
          "startMode" in benchmarkCase && benchmarkCase.startMode === "new-application-state"
            ? "sealed-p0"
            : "sealed-p1"
        const result = await driver.execute({ scenarioId, stateHandle, case: benchmarkCase })
        expect(result.caseId).toBe(benchmarkCase.caseId)
        expect(result.durationMs).toBeGreaterThan(0)
        if (scenarioId === "app-start-v1") await driver.shutdown()
      }
      if (scenarioId === "workspace-panel-v1") {
        expect(scenario.cases.actions).toEqual([...WORKSPACE_PANEL_ACTIONS])
        expect(panelExecutions.map((item) => item.benchmarkCase)).toEqual(cases)
        expect(new Set(panelExecutions.map((item) => (item.preset as { id: string }).id))).toEqual(
          new Set(["light", "moderate", "heavy"]),
        )
      }
      if (scenarioId === "session-navigation-v1") {
        expect(navigationExecutions.map((item) => item.benchmarkCase)).toEqual(cases)
      }
      await driver.shutdown()
    }
  })

  test("arms panel readiness before click and returns its exact stable-paint timestamp", async () => {
    const order: string[] = []
    let paint: ((at: number) => void) | undefined
    const paintedAt = await runPrearmedStablePaint({
      arm: () => {
        order.push("armed")
        return new Promise<number>((resolve) => {
          paint = resolve
        })
      },
      click: async () => {
        order.push("click")
        paint?.(37)
      },
      cancel: async () => {
        order.push("cancel")
      },
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
      const before = performance.now()
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

      // Two identical closed frames are required (frames 4 and 5); the endpoint is the
      // observation time of the second one, not the frame's scheduled timestamp.
      expect(frameCount).toBe(5)
      expect(at).toBeGreaterThanOrEqual(before)
      expect(at).toBeLessThanOrEqual(performance.now())
    } finally {
      for (const [name, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else delete (globalThis as Record<string, unknown>)[name]
      }
    }
  })

  test("rejects a panel scenario that does not define all authoritative presets", async () => {
    const { driver } = harness()
    await expect(
      driver.prepare({
        scenarioId: "workspace-panel-v1",
        scenarioDigestSha256: "1".repeat(64),
        corpusDirectory: "/tmp/corpus",
        corpusManifestPath: "/tmp/corpus/manifest.json",
        corpusDigestSha256: "a".repeat(64),
        corpusDefinitionDigestSha256: "2".repeat(64),
        eventSchemaDigestSha256: "b".repeat(64),
        runDirectory: "/tmp/run",
        scenarioDefinition: { cases: { panelLoads: panelScenarioDefinition.cases.panelLoads!.slice(0, 2) } },
        workspaceFixtureManifest: workspaceFixtureManifest as never,
      }),
    ).rejects.toThrow("must define light, moderate, and heavy")
  })
})
