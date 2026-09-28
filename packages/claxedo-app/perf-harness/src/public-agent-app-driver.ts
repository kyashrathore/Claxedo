#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  frameLogOf,
  serveDriver,
  type DriverHandlers,
  type FrameLog,
  type PageSettle,
  type PrepareParams,
} from "agent-app-benchmark/driver-sdk"
import { measureSessionActivation } from "./agent-browser-observer"
import { ensureFrontWindow } from "./front-window"
import { readText } from "./page-value"
import { launchPackagedClaxedo, type ClaxedoLaunch, type OwnedProcess as LaunchedProcess } from "./agent-claxedo-launcher"
import { isRecord, numberField, textField } from "./json-fields"
import {
  materializeClaxedoPublicCorpus,
  type ClaxedoPublicMaterialization,
  type CorpusReadinessTarget,
} from "./public-corpus-materializer"

/**
 * The resource workload's return to control is a validity check, not a scored
 * latency; the compared driver uses the same ceiling so a return that never
 * becomes ready costs both runs the same bounded wait.
 */
const RESOURCE_CONTROL_READINESS_TIMEOUT_MS = 5_000

const APP_START_SCENARIO_IDS: readonly string[] = ["app-start", "app-start-real-sessions"]
const SESSION_SWITCH_SCENARIO_IDS: readonly string[] = ["session-switch-walk", "session-switch-walk-real-sessions"]

export const PUBLIC_SCENARIO_IDS = ["app-start", "session-switch-walk"] as const

/**
 * Scenarios over the private corpus of redacted real sessions. They cannot be
 * registered, so they are served here beside the registered ones.
 */
export const PRIVATE_CORPUS_SCENARIO_IDS = ["app-start-real-sessions", "session-switch-walk-real-sessions"] as const

const SERVED_SCENARIO_IDS: readonly string[] = [...PUBLIC_SCENARIO_IDS, ...PRIVATE_CORPUS_SCENARIO_IDS]

/**
 * A launched process as the public driver reports it: exactly what the launcher
 * accounts for, plus the role this driver assigns. Previously a hand-written
 * copy of the launcher's type, which is why both read sites asserted.
 */
type OwnedProcess = LaunchedProcess & { role?: "main" }

type ReadinessReceipt = {
  endpoint: "correct-content-painted-and-input-ready"
  checks: Array<{ id: string; passed: boolean; observedAt?: number }>
}

type Clock = {
  kind: "single-monotonic-clock"
  clock: string
  start: number
  end: number
}

type Target = CorpusReadinessTarget
type Prepared = {
  materialization: ClaxedoPublicMaterialization
  stateHandles: { P0: string; P1: string }
}

type LaunchParams = {
  scenarioId: string
  stateHandle: string
  initialSessionId: string
  groupId: string
}

type SwitchCase = {
  caseId: string
  workload: "progressive-resource" | "resource-control" | "list-walk"
  sessionState?: "cold" | "warm"
  /** A list walk's step within its pass; step 0 enters the list from outside or wraps to its top. */
  walkPosition?: number
  sourceSessionId?: string
  destinationSessionId: string
}

type StartCase = {
  caseId: string
  startMode: "new-application-state" | "initialized-application-state"
}

type ExecuteParams = {
  scenarioId: string
  stateHandle?: string
  case: SwitchCase | StartCase
}

type ActiveLaunch = {
  processes: OwnedProcess[]
  readiness: ReadinessReceipt
  clock: Clock
  frameLog: FrameLog
}

/** A measured activation: its clock and the frames the clock was derived from. */
type Activation = { clock: Clock; frameLog: FrameLog }

type DriverDependencies = {
  hello: Record<string, unknown>
  prepare(params: PrepareParams): Promise<Prepared>
  launch(stateHandle: string, initialSessionId: string): Promise<ActiveLaunch>
  activate(target: Target, readinessTimeoutMs?: number): Promise<Activation>
  /** Native session ids of the rail's session rows, top to bottom. */
  listedSessionIds(): Promise<readonly string[]>
  shutdown(): Promise<LaunchShutdown>
}

/** What a shutdown accounts for: every process it ended, and every one it did not. */
type ShutdownResult = { terminated: OwnedProcess[]; survivors: OwnedProcess[] }
type LaunchShutdown = ShutdownResult & { forced: OwnedProcess[] }

export type ClaxedoPublicDriver = {
  hello(): Promise<Record<string, unknown>>
  prepare(params: PrepareParams): Promise<Record<string, unknown>>
  launch(params: LaunchParams): Promise<Record<string, unknown>>
  execute(params: ExecuteParams): Promise<Record<string, unknown>>
  shutdown(): Promise<ShutdownResult>
}

export function createClaxedoPublicDriver(dependencies: DriverDependencies): ClaxedoPublicDriver {
  let prepared: Prepared | undefined
  let active = false
  let preparedScenarioId: string | undefined
  /** Logical session ids the list walk has shown in the running process. */
  let walkedSessions = new Set<string>()

  const requirePrepared = () => {
    if (!prepared) throw new Error("Claxedo driver has not prepared the public corpus")
    return prepared
  }
  const resolveTarget = (logicalSessionId: string) => {
    const target = requirePrepared().materialization.readinessTargets.get(logicalSessionId)
    if (!target) throw new Error(`Claxedo has no materialized target for ${logicalSessionId}`)
    return target
  }
  const requireStateHandle = (stateHandle: string) => {
    const handles = requirePrepared().stateHandles
    if (stateHandle !== handles.P0 && stateHandle !== handles.P1)
      throw new Error("Claxedo rejected an unknown state handle")
  }

  return {
    hello: async () => ({ ...dependencies.hello, scenarios: [...SERVED_SCENARIO_IDS] }),
    prepare: async (params) => {
      if (prepared) throw new Error("Claxedo driver is already prepared")
      if (!SERVED_SCENARIO_IDS.includes(params.scenarioId)) {
        throw new Error(`Claxedo does not support scenario ${params.scenarioId}`)
      }
      prepared = await dependencies.prepare(params)
      preparedScenarioId = params.scenarioId
      return {
        materializationMode: "native-opencode",
        corpusDigestSha256: prepared.materialization.corpusDigestSha256,
        eventSchemaDigestSha256: prepared.materialization.eventSchemaDigestSha256,
        mappingDigestSha256: prepared.materialization.mappingDigestSha256,
        stateHandles: prepared.stateHandles,
        sessionMapping: prepared.materialization.sessionMapping,
      }
    },
    launch: async (params) => {
      if (params.scenarioId !== preparedScenarioId) throw new Error("Claxedo launch scenario differs from preparation")
      if (active) throw new Error("Claxedo application is already running")
      requireStateHandle(params.stateHandle)
      resolveTarget(params.initialSessionId)
      const launch = await dependencies.launch(params.stateHandle, params.initialSessionId)
      if (launch.processes.length === 0) throw new Error("Claxedo launch returned no application root")
      active = true
      walkedSessions = new Set()
      return { ready: true, processes: launch.processes, readiness: launch.readiness }
    },
    execute: async (params) => {
      if (params.scenarioId !== preparedScenarioId) throw new Error("Claxedo execute scenario differs from preparation")
      if (APP_START_SCENARIO_IDS.includes(params.scenarioId)) {
        if (active) throw new Error("Claxedo app-start requires no running application")
        if (!("startMode" in params.case) || !params.stateHandle)
          throw new Error("Claxedo app-start request is incomplete")
        requireStateHandle(params.stateHandle)
        const launch = await dependencies.launch(params.stateHandle, "control")
        active = true
        return { ...execution(params.case.caseId, launch.clock, withTimingEvidence(launch.readiness, launch.clock.end)), frameLog: launch.frameLog }
      }
      if (!SESSION_SWITCH_SCENARIO_IDS.includes(params.scenarioId) || "startMode" in params.case) {
        throw new Error(`Claxedo does not support scenario ${params.scenarioId}`)
      }
      if (!active) throw new Error("Claxedo session switching requires a running application")
      const benchmarkCase = params.case
      const destination = resolveTarget(benchmarkCase.destinationSessionId)
      if (benchmarkCase.workload === "list-walk") {
        const source = resolveTarget(benchmarkCase.sourceSessionId ?? "control")
        if ((benchmarkCase.sessionState === "cold") === walkedSessions.has(destination.logicalSessionId)) {
          throw new Error(`Claxedo list-walk ${benchmarkCase.sessionState} step to ${destination.logicalSessionId} does not match this process's visits`)
        }
        if (benchmarkCase.walkPosition !== 0) {
          const listed = await dependencies.listedSessionIds()
          const sourceRow = listed.indexOf(source.sessionId)
          if (sourceRow < 0 || listed[sourceRow + 1] !== destination.sessionId) {
            throw new Error(`Claxedo lists ${destination.logicalSessionId} ${sourceRow < 0 ? "without" : "not directly below"} ${source.logicalSessionId}`)
          }
        }
        const measured = await dependencies.activate(destination)
        walkedSessions.add(destination.logicalSessionId)
        return activationExecution(benchmarkCase.caseId, measured)
      }
      if (benchmarkCase.workload === "progressive-resource") {
        await dependencies.activate(resolveTarget(benchmarkCase.sourceSessionId ?? "control"))
      }
      const measured = await dependencies.activate(
        destination,
        benchmarkCase.workload === "resource-control" ? RESOURCE_CONTROL_READINESS_TIMEOUT_MS : undefined,
      )
      return activationExecution(benchmarkCase.caseId, measured)
    },
    shutdown: async () => {
      const { terminated, survivors } = await dependencies.shutdown()
      active = false
      walkedSessions = new Set()
      return { terminated, survivors }
    },
  }
}

function execution(caseId: string, clock: Clock, readiness: ReadinessReceipt) {
  return { caseId, durationMs: clock.end - clock.start, clock, readiness }
}

function activationExecution(caseId: string, measured: Activation) {
  return { ...execution(caseId, measured.clock, readinessReceipt(measured.clock.end)), frameLog: measured.frameLog }
}

/** A switch on the renderer's clock: from the trusted pointerdown to the settle frame. */
export function switchActivation(settle: PageSettle): Activation {
  return {
    clock: {
      kind: "single-monotonic-clock",
      clock: "claxedo-renderer-performance",
      start: settle.startAt,
      end: settle.settledAt,
    },
    frameLog: frameLogOf(settle),
  }
}

function readinessReceipt(observedAt?: number): ReadinessReceipt {
  return {
    endpoint: "correct-content-painted-and-input-ready",
    checks: [
      { id: "content-identity", passed: true, ...(observedAt === undefined ? {} : { observedAt }) },
      { id: "first-fold-painted", passed: true, ...(observedAt === undefined ? {} : { observedAt }) },
      { id: "two-presentations", passed: true, ...(observedAt === undefined ? {} : { observedAt }) },
      { id: "trusted-input", passed: true, ...(observedAt === undefined ? {} : { observedAt }) },
    ],
  }
}

function withTimingEvidence(receipt: ReadinessReceipt, observedAt: number): ReadinessReceipt {
  return {
    ...receipt,
    checks: receipt.checks.map((check) => ({ ...check, observedAt: check.observedAt ?? observedAt })),
  }
}

const APPLICATION = { id: "claxedo", name: "Claxedo" } as const

async function makeDefaultDependencies(): Promise<DriverDependencies> {
  const repoRoot = path.resolve(import.meta.dir, "../../../..")
  const executable = await discoverPackagedExecutable()
  const desktopPackage: unknown = JSON.parse(
    await readFile(path.join(repoRoot, "packages/claxedo-desktop/package.json"), "utf8"),
  )
  const desktopVersion = isRecord(desktopPackage) ? textField(desktopPackage, "version") : undefined
  if (desktopVersion === undefined || desktopVersion.length === 0)
    throw new Error("Claxedo desktop version is missing")
  const sourceCommit = await gitOutput(repoRoot, ["rev-parse", "HEAD"])
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("Claxedo source revision is invalid")
  const driverDigestSha256 = await hashFiles([
    import.meta.path,
    path.join(import.meta.dir, "public-corpus-materializer.ts"),
    path.join(import.meta.dir, "corpus-workspace.ts"),
    path.join(import.meta.dir, "fixture-registration.ts"),
    path.join(import.meta.dir, "opencode-corpus.ts"),
    path.join(import.meta.dir, "with-claxedo-data-directory.ts"),
    path.join(import.meta.dir, "agent-claxedo-launcher.ts"),
    path.join(import.meta.dir, "agent-browser-observer.ts"),
    path.join(import.meta.dir, "claxedo-settle-facts.ts"),
    path.join(import.meta.dir, "browser/painted-frames.ts"),
    path.join(import.meta.dir, "agent-cdp-page.ts"),
    path.join(import.meta.dir, "agent-display-contract.ts"),
    path.join(import.meta.dir, "agent-process-family.ts"),
    path.join(import.meta.dir, "idle-process-family.ts"),
  ])
  const buildDigestSha256 = await hashFiles(await applicationBuildFiles(executable))

  let readinessTargets: ReadonlyMap<string, Target> = new Map()
  let current: ClaxedoLaunch | undefined
  let activeStateRoot: string | undefined
  let removeActiveState = false
  let attemptSequence = 0
  let attemptsRoot: string | undefined

  const closeCurrent = async () => {
    const launch = current
    const stateRoot = activeStateRoot
    const removeState = removeActiveState
    current = undefined
    activeStateRoot = undefined
    removeActiveState = false
    if (!launch) return { terminated: [], survivors: [], forced: [] }
    const result = await launch.shutdown()
    if (removeState && result.survivors.length === 0 && stateRoot) await rm(stateRoot, { recursive: true, force: true })
    if (result.forced.length > 0) {
      process.stderr.write(`claxedo-driver: shutdown force-killed ${result.forced.map((item) => `${item.category}:${item.pid}`).join(", ")}\n`)
    }
    return { terminated: result.terminated, survivors: result.survivors, forced: result.forced }
  }

  const startState = async (stateRoot: string, disposable: boolean): Promise<ActiveLaunch> => {
    if (current) throw new Error("Claxedo application is already running")
    const targets = [...readinessTargets.values()]
    const control = readinessTargets.get("control")
    if (!control || targets.length === 0) throw new Error("Claxedo control readiness target is missing")
    const launch = await launchPackagedClaxedo({
      executable,
      isolatedProfilePath: path.join(stateRoot, "profile"),
      dataDirectory: path.join(stateRoot, "data"),
      homeDirectory: path.join(stateRoot, "ambient"),
      readinessTargets: [control, ...targets.filter((target) => target.logicalSessionId !== "control")],
    })
    current = launch
    activeStateRoot = stateRoot
    removeActiveState = disposable
    return {
      processes: [{ ...launch.process, role: "main" }],
      readiness: readinessReceipt(launch.coldReady.endTimestamp),
      clock: {
        kind: "single-monotonic-clock",
        clock: "bun-performance",
        start: launch.coldReady.startTimestamp,
        end: launch.coldReady.endTimestamp,
      },
      frameLog: launch.coldReady.frameLog,
    }
  }

  return {
    hello: {
      protocolVersion: 1,
      application: { ...APPLICATION, version: desktopVersion, buildDigestSha256 },
      driver: { name: "claxedo-reference", version: "3", sourceCommit, digestSha256: driverDigestSha256 },
      sourceEventFormats: ["opencode-event"],
      materializationModes: ["native-opencode"],
      guiFramework: "electron",
      clockRule: "settle-31-frames",
    },
    prepare: async (params) => {
      const runRoot = path.join(path.resolve(params.runDirectory), "driver-state", APPLICATION.id)
      attemptsRoot = path.join(runRoot, "attempts")
      const cacheRoot = process.env.AGENT_APP_BENCHMARK_STATE_CACHE
      if (cacheRoot) await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
      const privateRoot = cacheRoot ?? runRoot
      const p0 = path.join(privateRoot, "P0")
      const p1 = path.join(privateRoot, "P1")
      const cached = cacheRoot ? await readPreparedCache(cacheRoot, params.corpusDigestSha256) : undefined
      if (cached) {
        readinessTargets = cached.readinessTargets
        return { materialization: cached, stateHandles: { P0: p0, P1: p1 } }
      }
      await Promise.all([
        mkdir(path.join(p0, "profile"), { recursive: true, mode: 0o700 }),
        mkdir(path.join(p0, "data"), { recursive: true, mode: 0o700 }),
      ])
      const materialization = await materializeClaxedoPublicCorpus({
        corpusDirectory: params.corpusDirectory,
        corpusManifestPath: params.corpusManifestPath,
        expectedCorpusDigestSha256: params.corpusDigestSha256,
        expectedEventSchemaDigestSha256: params.eventSchemaDigestSha256,
        dataDirectory: path.join(p0, "data"),
        workspaceDirectory: path.join(privateRoot, "workspaces"),
      })
      readinessTargets = materialization.readinessTargets
      const seedInitializedState = async () => {
        await cp(p0, p1, { recursive: true, errorOnExist: true, mode: fsConstants.COPYFILE_FICLONE })
        await startState(p1, false)
        const initialized = await closeCurrent()
        if (initialized.survivors.length > 0) throw new Error("Claxedo P1 initialization left a surviving process")
        if (initialized.forced.length > 0) {
          throw new Error("Claxedo P1 initialization force-killed its daemon; the initialized state would start with a stale daemon record")
        }
      }
      try {
        await seedInitializedState()
      } catch (error) {
        const evidence = await preserveLaunchFailureEvidence(p1, error)
        throw new Error(`Claxedo P1 initialization failed: ${error instanceof Error ? error.message : String(error)}; logs kept at ${evidence}`, { cause: error })
      }
      if (cacheRoot) await writePreparedCache(cacheRoot, materialization)
      return { materialization, stateHandles: { P0: p0, P1: p1 } }
    },
    launch: async (stateHandle, initialSessionId) => {
      if (initialSessionId !== "control") throw new Error("Claxedo public launch must begin at the control session")
      if (!attemptsRoot) throw new Error("Claxedo launch requires preparation")
      const attempt = path.join(attemptsRoot, String(attemptSequence++))
      await mkdir(path.dirname(attempt), { recursive: true, mode: 0o700 })
      await cp(stateHandle, attempt, { recursive: true, errorOnExist: true, mode: fsConstants.COPYFILE_FICLONE })
      try {
        return await startState(attempt, true)
      } catch (error) {
        await rm(attempt, { recursive: true, force: true })
        throw error
      }
    },
    activate: async (target, readinessTimeoutMs) => {
      if (!current) throw new Error("Claxedo renderer is not running")
      await ensureFrontWindow(current.page, current.application.pid)
      return switchActivation(
        await measureSessionActivation(current.page, target, { readinessTimeoutMs }),
      )
    },
    listedSessionIds: async () => {
      if (!current) throw new Error("Claxedo renderer is not running")
      const rows = await current.page.evaluate(() =>
        Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid="rail-sidebar-session-row"][data-session-id]'),
          (row) => row.dataset.sessionId ?? "",
        ),
      )
      if (!Array.isArray(rows)) throw new Error("Claxedo rail rows did not read as a list")
      return rows.map(readText)
    },
    shutdown: closeCurrent,
  }
}

/** Copies the app-side logs of a failed unmeasured launch out of the private run directory before it is discarded. */
async function preserveLaunchFailureEvidence(stateRoot: string, error: unknown) {
  const root = path.join(tmpdir(), "claxedo-benchmark-launch-failures", new Date().toISOString().replaceAll(":", "-"))
  await mkdir(root, { recursive: true, mode: 0o700 })
  await writeFile(
    path.join(root, "error.txt"),
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  for (const relative of [
    "ambient/Library/Logs",
    "ambient/.local/share/opencode/log",
    "app-stdout.log",
    "app-stderr.log",
  ]) {
    await cp(path.join(stateRoot, relative), path.join(root, relative), { recursive: true, force: true }).catch(
      () => undefined,
    )
  }
  return root
}

async function discoverPackagedExecutable() {
  const configured = process.env.CLAXEDO_BENCHMARK_EXECUTABLE?.trim()
  if (configured) {
    await access(configured)
    return path.resolve(configured)
  }
  const desktop = path.resolve(import.meta.dir, "../../../claxedo-desktop")
  const productName = process.env.CLAXEDO_CHANNEL === "prod" ? "Claxedo" : "Claxedo Dev"
  const suffix = process.arch === "arm64" ? "-arm64" : ""
  const candidate =
    process.platform === "darwin"
      ? path.join(desktop, "dist", `mac${suffix}`, `${productName}.app`, "Contents", "MacOS", productName)
      : process.platform === "win32"
        ? path.join(desktop, "dist", "win-unpacked", `${productName}.exe`)
        : path.join(desktop, "dist", "linux-unpacked", productName.toLowerCase().replaceAll(" ", "-"))
  await access(candidate)
  return candidate
}

const PREPARED_CACHE_FILE = "prepared.json"

/**
 * Written only after P1 seeding succeeded, so its presence means both state
 * handles beside it are complete. Launches copy the handles, which keeps P0
 * never-launched for every scenario that reuses it.
 */
export async function writePreparedCache(cacheRoot: string, materialization: ClaxedoPublicMaterialization) {
  await writeFile(
    path.join(cacheRoot, PREPARED_CACHE_FILE),
    JSON.stringify({ ...materialization, readinessTargets: [...materialization.readinessTargets] }),
    { mode: 0o600 },
  )
}

export async function readPreparedCache(
  cacheRoot: string,
  corpusDigestSha256: string,
): Promise<ClaxedoPublicMaterialization | undefined> {
  const text = await readFile(path.join(cacheRoot, PREPARED_CACHE_FILE), "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  const record: unknown = JSON.parse(text)
  const materialization = isRecord(record) ? parsePreparedCache(record) : undefined
  if (!materialization || materialization.corpusDigestSha256 !== corpusDigestSha256)
    throw new Error("Claxedo prepared-state cache is unreadable or belongs to a different corpus")
  return materialization
}

function parsePreparedCache(record: Record<string, unknown>): ClaxedoPublicMaterialization | undefined {
  const corpusDigestSha256 = textField(record, "corpusDigestSha256")
  const eventSchemaDigestSha256 = textField(record, "eventSchemaDigestSha256")
  const mappingDigestSha256 = textField(record, "mappingDigestSha256")
  const sessionMapping = stringRecord(record.sessionMapping)
  const messageCount = numberField(record, "messageCount")
  const transcriptBytes = numberField(record, "transcriptBytes")
  const entries = Array.isArray(record.readinessTargets) ? record.readinessTargets : undefined
  if (
    !corpusDigestSha256 ||
    !eventSchemaDigestSha256 ||
    !mappingDigestSha256 ||
    !sessionMapping ||
    messageCount === undefined ||
    transcriptBytes === undefined ||
    !entries
  )
    return undefined
  const readinessTargets = new Map<string, Target>()
  for (const entry of entries) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || !isRecord(entry[1])) return undefined
    const target = parseCachedTarget(entry[1])
    if (!target) return undefined
    readinessTargets.set(entry[0], target)
  }
  return {
    corpusDigestSha256,
    eventSchemaDigestSha256,
    mappingDigestSha256,
    sessionMapping,
    readinessTargets,
    messageCount,
    transcriptBytes,
  }
}

function parseCachedTarget(
  record: Record<string, unknown>,
): Target | undefined {
  const sessionId = textField(record, "sessionId")
  const title = textField(record, "title")
  const logicalSessionId = textField(record, "logicalSessionId")
  const workspaceDirectory = textField(record, "workspaceDirectory")
  const expectedMessageIds = stringArray(record.expectedMessageIds)
  const expectedPartIds = stringArray(record.expectedPartIds)
  if (
    !sessionId ||
    title === undefined ||
    !logicalSessionId ||
    !workspaceDirectory ||
    !expectedMessageIds ||
    !expectedPartIds
  )
    return undefined
  return {
    sessionId,
    title,
    logicalSessionId,
    workspaceDirectory,
    expectedMessageIds,
    expectedPartIds,
  }
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((item): item is string => typeof item === "string")
  return strings.length === value.length ? strings : undefined
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value)
  const strings = entries.filter((entry): entry is [string, string] => typeof entry[1] === "string")
  return strings.length === entries.length ? Object.fromEntries(strings) : undefined
}

async function applicationBuildFiles(executable: string) {
  if (process.platform !== "darwin") return [executable]
  const asar = path.resolve(path.dirname(executable), "../Resources/app.asar")
  await access(asar)
  return [executable, asar]
}

async function hashFiles(files: string[]) {
  const hash = createHash("sha256")
  for (const file of files) {
    const reader = Bun.file(file).stream().getReader()
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      hash.update(chunk.value)
    }
  }
  return hash.digest("hex")
}

async function gitOutput(repoRoot: string, args: string[]) {
  const child = Bun.spawn({ cmd: ["git", ...args], cwd: repoRoot, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`Unable to read Claxedo source identity: ${(stderr || stdout).trim()}`)
  return stdout.trim()
}

function requiredString(params: Record<string, unknown>, name: string) {
  const value = params[name]
  if (typeof value !== "string" || value.length === 0) throw new Error(`Claxedo driver requires ${name}`)
  return value
}

// The protocol hands these three readers whatever the caller sent. They take
// `unknown` and check it, rather than being declared as already-validated
// records and asserted into at the call site.
function prepareParams(params: unknown): PrepareParams {
  if (!isRecord(params)) throw new Error("Claxedo driver prepare requires an object")
  return {
    scenarioId: requiredString(params, "scenarioId"),
    scenarioDigestSha256: requiredString(params, "scenarioDigestSha256"),
    corpusDirectory: requiredString(params, "corpusDirectory"),
    corpusManifestPath: requiredString(params, "corpusManifestPath"),
    corpusDigestSha256: requiredString(params, "corpusDigestSha256"),
    corpusDefinitionDigestSha256: requiredString(params, "corpusDefinitionDigestSha256"),
    eventSchemaDigestSha256: requiredString(params, "eventSchemaDigestSha256"),
    runDirectory: requiredString(params, "runDirectory"),
    ...(isRecord(params.scenarioDefinition) ? { scenarioDefinition: params.scenarioDefinition } : {}),
  }
}

function launchParams(params: unknown): LaunchParams {
  if (!isRecord(params)) throw new Error("Claxedo driver launch requires an object")
  return {
    scenarioId: requiredString(params, "scenarioId"),
    stateHandle: requiredString(params, "stateHandle"),
    initialSessionId: requiredString(params, "initialSessionId"),
    groupId: requiredString(params, "groupId"),
  }
}

/**
 * Read an unvalidated benchmark case from the driver protocol. A switch case is
 * discriminated by `workload`, a start case by `startMode`; reading them here
 * names a malformed field at the protocol boundary instead of failing
 * mid-measurement as a missing session id.
 */
function parseBenchmarkCase(value: unknown): SwitchCase | StartCase {
  if (!isRecord(value)) throw new Error("Claxedo driver requires a benchmark case")
  const caseId = textField(value, "caseId")
  if (caseId === undefined) throw new Error("Claxedo driver benchmark case is missing caseId")
  const workload = textField(value, "workload")

  if (workload === "progressive-resource" || workload === "resource-control" || workload === "list-walk") {
    const destinationSessionId = textField(value, "destinationSessionId")
    if (destinationSessionId === undefined) {
      throw new Error(`Claxedo driver switch case ${caseId} is missing destinationSessionId`)
    }
    const sessionState = textField(value, "sessionState")
    const sourceSessionId = textField(value, "sourceSessionId")
    const walkPosition = numberField(value, "walkPosition")
    return {
      caseId,
      workload,
      destinationSessionId,
      ...(sessionState === "cold" || sessionState === "warm" ? { sessionState } : {}),
      ...(walkPosition === undefined ? {} : { walkPosition }),
      ...(sourceSessionId === undefined ? {} : { sourceSessionId }),
    }
  }

  const startMode = textField(value, "startMode")
  if (startMode === "new-application-state" || startMode === "initialized-application-state") {
    return { caseId, startMode }
  }
  throw new Error(`Claxedo driver does not support benchmark case ${caseId}`)
}

function executeParams(params: unknown): ExecuteParams {
  if (!isRecord(params)) throw new Error("Claxedo driver execute requires an object")
  return {
    scenarioId: requiredString(params, "scenarioId"),
    ...(typeof params.stateHandle === "string" ? { stateHandle: params.stateHandle } : {}),
    case: parseBenchmarkCase(params.case),
  }
}

export async function runClaxedoPublicDriver() {
  const driver = createClaxedoPublicDriver(await makeDefaultDependencies())
  const handlers: DriverHandlers = {
    hello: async () => driver.hello(),
    prepare: async (params) => driver.prepare(prepareParams(params)),
    launch: async (params) => driver.launch(launchParams(params)),
    execute: async (params) => driver.execute(executeParams(params)),
    shutdown: async () => driver.shutdown(),
  }
  const cleanup = async () => {
    const { survivors } = await driver.shutdown()
    if (survivors.length > 0) throw new Error("Claxedo driver cleanup left a surviving process")
  }
  const terminate = (code: number) => void cleanup().finally(() => process.exit(code))
  process.once("SIGINT", () => terminate(130))
  process.once("SIGTERM", () => terminate(143))
  try {
    await serveDriver(handlers)
  } finally {
    await cleanup()
  }
}

if (import.meta.main) await runClaxedoPublicDriver()
