import { describe, expect, test } from "bun:test"
import { createClaxedoPublicDriver } from "../src/public-agent-app-driver"

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
  let clock = 10
  const target = (logicalSessionId: string, sessionId: string) => ({
    logicalSessionId,
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
    shutdown: async () => ({ terminated: [], survivors: [] }),
  })
  return { driver, activations, launches }
}

async function prepare(driver: ReturnType<typeof createClaxedoPublicDriver>) {
  return driver.prepare({
    scenarioId: "session-switch-v1",
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
    await prepare(driver)
    const result = await driver.execute({
      scenarioId: "app-start-v1",
      stateHandle: "sealed-p0",
      case: { caseId: "new-start", startMode: "new-application-state" },
    })
    expect(launches).toEqual([{ stateHandle: "sealed-p0", initialSessionId: "control" }])
    expect(result.durationMs).toBe(4)
  })
})
