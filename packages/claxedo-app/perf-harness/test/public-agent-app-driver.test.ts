import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  createClaxedoPublicDriver,
  parseApplicationArgument,
  PRIVATE_CORPUS_SCENARIO_IDS,
  PUBLIC_SCENARIO_IDS,
  readPreparedCache,
  writePreparedCache,
} from "../src/public-agent-app-driver"

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
  let clock = 10
  const target = (logicalSessionId: string, sessionId: string) => ({
    logicalSessionId,
    workspaceDirectory: "/tmp/workspace",
    sessionId,
    title: logicalSessionId,
    expectedMessageIds: [`message-${logicalSessionId}`],
    expectedPartIds: [],
  })
  const readinessTargets = new Map([
    ["control", target("control", "native-control")],
    ["progressive-resource-1048576", target("progressive-resource-1048576", "native-resource")],
  ])
  for (const id of extraSessionIds) readinessTargets.set(id, target(id, `native-${id}`))
  const listed = { ids: [...new Set(extraSessionIds)].map((id) => `native-${id}`) }
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
        frameLog: { startAt: 1, offsetMs: 0, frames: [] },
      }
    },
    activate: async (target) => {
      activations.push(target.logicalSessionId)
      const start = clock
      clock += 2
      return {
        clock: { kind: "single-monotonic-clock", clock: "test-renderer", start, end: clock },
        frameLog: { startAt: start, offsetMs: 0, frames: [] },
      }
    },
    listedSessionIds: async () => listed.ids,
    shutdown: async () => ({ terminated: [], survivors: [], forced: [] }),
  })
  return { driver, listed, activations, launches }
}

// Resolve the installed package so dependency drift cannot be hidden by a local
// reproduction of its fixtures or scheduler. The framework owns these cases.
const frameworkRoot = new URL("../", import.meta.resolve("agent-app-benchmark/driver-sdk"))
type Scenario = {
  id: string
  kind: string
  cases: Record<string, unknown>
}
const readScenario = async (id: string): Promise<Scenario> =>
  JSON.parse(await readFile(new URL(`registry/scenarios/${id}.json`, frameworkRoot), "utf8"))
type DriverCase = Parameters<ReturnType<typeof createClaxedoPublicDriver>["execute"]>[0]["case"]
const { expandCases, buildResourceSequence } = (await import(new URL("src/cases.mjs", frameworkRoot).href)) as {
  expandCases: (scenario: Scenario, profile: string) => DriverCase[]
  buildResourceSequence: (scenario: Scenario) => DriverCase[]
}
async function prepare(
  driver: ReturnType<typeof createClaxedoPublicDriver>,
  scenarioId = "session-switch-walk-v2",
  scenarioDefinition?: Scenario,
) {
  return driver.prepare({
    scenarioId,
    scenarioDefinition,
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
      await readFile(new URL("registry/apps/claxedo-v2.json", frameworkRoot), "utf8"),
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

  test("returns to control before each progressive step, and measures the return to control alone", async () => {
    const { driver, activations } = harness()
    await prepare(driver)
    await driver.launch({
      scenarioId: "session-switch-walk-v2",
      stateHandle: "sealed-p1",
      initialSessionId: "control",
      groupId: "group",
    })
    const step = await driver.execute({
      scenarioId: "session-switch-walk-v2",
      case: {
        caseId: "step",
        workload: "progressive-resource",
        sessionState: "cold",
        sourceSessionId: "control",
        destinationSessionId: "progressive-resource-1048576",
      },
    })
    const control = await driver.execute({
      scenarioId: "session-switch-walk-v2",
      case: { caseId: "control", workload: "resource-control", destinationSessionId: "control" },
    })
    expect(activations).toEqual(["control", "progressive-resource-1048576", "control"])
    expect(step.durationMs).toBe(2)
    expect(control.durationMs).toBe(2)
  })

  test("walks the list one row down per step, rejecting a step to anything but the next row", async () => {
    const scenario = await readScenario("session-switch-walk-v2")
    const cases = expandCases(scenario, "smoke")
    const ids = cases.flatMap((item) => ("destinationSessionId" in item ? [item.destinationSessionId] : []))
    const { driver, listed, activations } = harness(ids)
    await prepare(driver, "session-switch-walk-v2", scenario)
    await driver.launch({ scenarioId: "session-switch-walk-v2", stateHandle: "sealed-p1", initialSessionId: "control", groupId: "walk" })
    for (const benchmarkCase of cases) await driver.execute({ scenarioId: "session-switch-walk-v2", case: benchmarkCase })
    expect(activations).toEqual(ids)
    await driver.shutdown()
    await driver.launch({ scenarioId: "session-switch-walk-v2", stateHandle: "sealed-p1", initialSessionId: "control", groupId: "walk" })
    listed.ids = [listed.ids[1]!, listed.ids[0]!, ...listed.ids.slice(2)]
    await driver.execute({ scenarioId: "session-switch-walk-v2", case: cases[0]! })
    await expect(driver.execute({ scenarioId: "session-switch-walk-v2", case: cases[1]! })).rejects.toThrow(/not directly below/)
    await expect(driver.execute({ scenarioId: "session-switch-walk-v2", case: { ...cases[0]!, caseId: "again" } })).rejects.toThrow(
      /does not match this process's visits/,
    )
  })

  test("measures application start from the requested exact state", async () => {
    const { driver, launches } = harness()
    await prepare(driver, "app-start-fast-v3")
    const result = await driver.execute({
      scenarioId: "app-start-fast-v3",
      stateHandle: "sealed-p0",
      case: { caseId: "new-start", startMode: "new-application-state" },
    })
    expect(launches).toEqual([{ stateHandle: "sealed-p0", initialSessionId: "control" }])
    expect(result.durationMs).toBe(4)
  })

  test("rejects a scenario it does not serve", async () => {
    const { driver } = harness()
    await expect(prepare(driver, "workspace-panel-v1")).rejects.toThrow("does not support")
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
      const { driver } = harness(ids)
      expect((await driver.hello()).scenarios).toEqual([...PUBLIC_SCENARIO_IDS, ...PRIVATE_CORPUS_SCENARIO_IDS])
      await prepare(driver, scenarioId, scenario)
      if (scenario.kind !== "app-start") {
        await driver.launch({ scenarioId, stateHandle: "sealed-p1", initialSessionId: "control", groupId: "group" })
      }
      let repetition = cases[0] && "repetition" in cases[0] ? cases[0].repetition : undefined
      for (const benchmarkCase of cases) {
        // The framework launches a fresh process for every repetition's group.
        const caseRepetition = "repetition" in benchmarkCase ? benchmarkCase.repetition : undefined
        if (scenario.kind !== "app-start" && caseRepetition !== repetition) {
          await driver.shutdown()
          await driver.launch({ scenarioId, stateHandle: "sealed-p1", initialSessionId: "control", groupId: "group" })
          repetition = caseRepetition
        }
        const stateHandle =
          "startMode" in benchmarkCase && benchmarkCase.startMode === "new-application-state"
            ? "sealed-p0"
            : "sealed-p1"
        const result = await driver.execute({ scenarioId, stateHandle, case: benchmarkCase })
        expect(result.caseId).toBe(benchmarkCase.caseId)
        expect(result.durationMs).toBeGreaterThan(0)
        if (scenario.kind === "app-start") await driver.shutdown()
      }
      await driver.shutdown()
    }
  })
})

describe("Claxedo prepared-state cache", () => {
  const target = {
    sessionId: "ses_control",
    title: "1. Synthetic benchmark control",
    logicalSessionId: "control",
    workspaceDirectory: "/workspaces/workspace-a",
    expectedMessageIds: ["msg_1"],
    expectedPartIds: ["prt_1", "prt_2"],
  }
  const materialization = {
    corpusDigestSha256: "c".repeat(64),
    eventSchemaDigestSha256: "d".repeat(64),
    mappingDigestSha256: "e".repeat(64),
    sessionMapping: { control: "ses_control" },
    readinessTargets: new Map([["control", target]]),
    messageCount: 152,
    transcriptBytes: 1_048_576,
  }

  test("a later scenario reads back exactly the materialization the first one wrote", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-prepared-cache-"))
    try {
      expect(await readPreparedCache(root, materialization.corpusDigestSha256)).toBeUndefined()
      await writePreparedCache(root, materialization)
      expect(await readPreparedCache(root, materialization.corpusDigestSha256)).toEqual(materialization)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a cache from another corpus or with a malformed target is rejected, not reused", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-prepared-cache-"))
    try {
      await writePreparedCache(root, materialization)
      await expect(readPreparedCache(root, "f".repeat(64))).rejects.toThrow("different corpus")
      await writeFile(
        path.join(root, "prepared.json"),
        JSON.stringify({ ...materialization, readinessTargets: [["control", { ...target, expectedMessageIds: [1] }]] }),
      )
      await expect(readPreparedCache(root, materialization.corpusDigestSha256)).rejects.toThrow("unreadable")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("the application argument", () => {
  test("names today's app by default and the v2 rebuild only when asked", () => {
    expect(parseApplicationArgument([])).toBe("claxedo")
    expect(parseApplicationArgument(["--application", "claxedo-v2"])).toBe("claxedo-v2")
  })

  test("rejects anything else rather than falling back to today's app", () => {
    expect(() => parseApplicationArgument(["--application", "claxedo-v3"])).toThrow(/--application/)
    expect(() => parseApplicationArgument(["--application"])).toThrow(/--application/)
    expect(() => parseApplicationArgument(["--app", "claxedo-v2"])).toThrow(/--application/)
    expect(() => parseApplicationArgument(["--application", "claxedo-v2", "extra"])).toThrow(/--application/)
  })
})
