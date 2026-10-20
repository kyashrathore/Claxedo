#!/usr/bin/env bun
import { appendFileSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { readString } from "@claxedo/helpers/readers"
import { sdk } from "./driver-sdk"
import { configuredExecutable, requirePackagedApp, sha256Files } from "./packaged-app"
import { prepareState, type PreparedState } from "./prepared-state"
import { RunningApp } from "./running-app"
import type { Activation } from "./settle"
import type { OwnedProcess } from "./shutdown"
import { executeListWalkStep, executeResourceStep, readSwitchCase } from "./switch-cases"

const APP_START_SCENARIO_IDS = ["app-start"]
const SESSION_SWITCH_SCENARIO_IDS = ["session-switch-walk"]
const READINESS_CHECKS = ["content-identity", "first-fold-painted", "two-presentations", "trusted-input"]

type Clock = { kind: "single-monotonic-clock"; clock: string; start: number; end: number }

const here = import.meta.dir
const repoRoot = path.resolve(here, "..", "..", "..", "..")
const logFile = process.env.CLAXEDO_BENCHMARK_DRIVER_LOG?.trim()
const log = (line: string) => {
  const entry = `[claxedo-driver ${new Date().toISOString().slice(11, 23)}] ${line}\n`
  process.stderr.write(entry)
  if (logFile) appendFileSync(logFile, entry)
}

function readinessReceipt(observedAt: number) {
  return { endpoint: "correct-content-painted-and-input-ready", checks: READINESS_CHECKS.map((id) => ({ id, passed: true, observedAt })) }
}

function execution(caseId: string, clock: Clock) {
  return { caseId, durationMs: clock.end - clock.start, clock, readiness: readinessReceipt(clock.end) }
}

function activationExecution(caseId: string, activation: Activation) {
  return { ...execution(caseId, activation.clock), frameLog: activation.frameLog }
}

async function gitHead(cwd: string) {
  const child = Bun.spawn({ cmd: ["git", "rev-parse", "HEAD"], cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  const commit = stdout.trim()
  if (code !== 0 || !/^[0-9a-f]{40}$/u.test(commit)) throw new Error("Claxedo source revision is invalid")
  return commit
}

async function driverSources() {
  return (await readdir(here)).filter((name) => name.endsWith(".ts")).sort().map((name) => path.join(here, name))
}

const app = await requirePackagedApp(configuredExecutable())
const desktopPackage: unknown = JSON.parse(await readFile(path.join(repoRoot, "packages", "claxedo-desktop", "package.json"), "utf8"))
const appVersion = readString(desktopPackage, "version")
if (appVersion === undefined) throw new Error("Claxedo desktop version is missing")
const sourceCommit = await gitHead(repoRoot)
const driverDigestSha256 = await sha256Files(await driverSources())
const buildDigestSha256 = await sha256Files([app.executable, app.asar])

let prepared: PreparedState | undefined
let current: RunningApp | undefined
let attemptSequence = 0

function requirePrepared() {
  if (!prepared) throw new Error("Claxedo driver has not prepared the corpus")
  return prepared
}

function requireStateHandle(handle: unknown) {
  const { P0, P1 } = requirePrepared().stateHandles
  if (handle !== P0 && handle !== P1) throw new Error("Claxedo rejected an unknown state handle")
  return handle
}

async function startFromHandle(handle: string) {
  if (current) throw new Error("Claxedo is already running")
  const { privateRoot, materialization } = requirePrepared()
  const attemptDir = path.join(privateRoot, "attempts", `${String(++attemptSequence).padStart(3, "0")}-${path.basename(handle)}`)
  current = await RunningApp.start({ app, materialization, handle, attemptDir, log })
  return current
}

async function closeCurrent() {
  const running = current
  current = undefined
  if (!running) return { terminated: [] as OwnedProcess[], survivors: [] as OwnedProcess[] }
  return running.close()
}

async function executeSwitch(scenarioId: string, requestedCase: unknown) {
  if (!SESSION_SWITCH_SCENARIO_IDS.includes(scenarioId)) throw new Error(`Claxedo driver does not support scenario ${scenarioId}`)
  if (!current) throw new Error("Claxedo session activation requires a running application")
  const benchmarkCase = readSwitchCase(requestedCase)
  const measured = benchmarkCase.workload === "list-walk"
    ? await executeListWalkStep(current, benchmarkCase)
    : await executeResourceStep(current, benchmarkCase)
  return activationExecution(benchmarkCase.caseId, measured)
}

await sdk.serveDriver({
  hello: async () => ({
    protocolVersion: 1,
    application: { id: "claxedo", name: "Claxedo", version: appVersion, buildDigestSha256 },
    driver: { name: "claxedo-desktop-driver", version: "1", sourceCommit, digestSha256: driverDigestSha256 },
    scenarios: [...APP_START_SCENARIO_IDS, ...SESSION_SWITCH_SCENARIO_IDS],
    sourceEventFormats: ["opencode-event"],
    materializationModes: ["native-opencode"],
    clockRule: "settle-31-frames",
    guiFramework: "electron",
  }),
  prepare: async (params) => {
    if (prepared) throw new Error("Claxedo driver is already prepared")
    const state = await prepareState({
      app,
      appVersion,
      buildDigestSha256,
      runDirectory: params.runDirectory,
      corpusDirectory: params.corpusDirectory,
      corpusManifestPath: params.corpusManifestPath,
      expectedCorpusDigestSha256: params.corpusDigestSha256,
      expectedEventSchemaDigestSha256: params.eventSchemaDigestSha256,
      log,
    })
    prepared = state
    const { materialization } = state
    return {
      materializationMode: "native-opencode",
      corpusDigestSha256: materialization.manifest.corpusDigestSha256,
      eventSchemaDigestSha256: materialization.manifest.sourceEventFormat.schemaDigestSha256,
      mappingDigestSha256: materialization.mappingDigestSha256,
      stateHandles: state.stateHandles,
    }
  },
  launch: async (params) => {
    const running = await startFromHandle(requireStateHandle(params.stateHandle))
    return { ready: true, processes: [running.launch.root], readiness: readinessReceipt(running.launch.readyAtMs) }
  },
  execute: async (params) => {
    const scenarioId = String(params.scenarioId)
    if (!APP_START_SCENARIO_IDS.includes(scenarioId)) return executeSwitch(scenarioId, params.case)
    if (current) throw new Error("Claxedo app start requires no running application")
    const caseId = readString(params.case, "caseId")
    if (caseId === undefined) throw new Error(`Claxedo received an app-start case without an id: ${JSON.stringify(params.case)}`)
    const { launch } = await startFromHandle(requireStateHandle(params.stateHandle))
    const clock: Clock = { kind: "single-monotonic-clock", clock: "bun-performance", start: launch.spawnAtMs, end: launch.readyAtMs }
    return { ...execution(caseId, clock), frameLog: launch.readyFrameLog }
  },
  shutdown: async () => closeCurrent(),
})
