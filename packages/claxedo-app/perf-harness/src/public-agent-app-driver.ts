#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { serveDriver, type DriverHandlers, type PrepareParams } from "agent-app-benchmark/driver-sdk"
import type { WorkspaceFixtureManifest, WorkspaceLoad } from "agent-app-benchmark/driver-sdk"
import { measureSessionActivation } from "./agent-browser-observer"
import { readFlag } from "./page-value"
import { launchPackagedClaxedo, type ClaxedoLaunch, type OwnedProcess as LaunchedProcess } from "./agent-claxedo-launcher"
import { isRecord, numberField, recordField, recordsField, textField } from "./json-fields"
import { materializeClaxedoPublicCorpus, type ClaxedoPublicMaterialization } from "./public-corpus-materializer"
import {
  executeWorkspacePanelAction,
  executeSessionNavigation,
  fixtureEvidence,
  publicPanelLoadPresets,
  WORKSPACE_PANEL_ACTIONS,
  SESSION_NAVIGATION_TYPES,
  PUBLIC_PANEL_LOAD_PROFILES,
  type PanelTarget,
  type PublicPanelLoadPreset,
  type PublicPanelLoadPresets,
  type SessionNavigationCase,
  type WorkspacePanelCase,
} from "./public-workspace-panel"

/**
 * The resource workload's return to control is a validity check, not a scored
 * latency; the compared driver uses the same ceiling so a return that never
 * becomes ready costs both runs the same bounded wait.
 */
const RESOURCE_CONTROL_READINESS_TIMEOUT_MS = 5_000

const APP_START_SCENARIO_IDS: readonly string[] = ["app-start-v1", "app-start-fast-v1"]
const SESSION_SWITCH_SCENARIO_IDS: readonly string[] = ["session-switch-v1", "session-switch-fast-v1"]

export const PUBLIC_SCENARIO_IDS = [
  "app-start-v1",
  "app-start-fast-v1",
  "session-switch-v1",
  "session-switch-fast-v1",
  "session-navigation-v1",
  "workspace-panel-v1",
] as const

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

type Target = PanelTarget
type Prepared = {
  materialization: ClaxedoPublicMaterialization
  stateHandles: { P0: string; P1: string }
  panelLoadPresets?: PublicPanelLoadPresets
}

type LaunchParams = {
  scenarioId: string
  stateHandle: string
  initialSessionId: string
  groupId: string
}

type SwitchCase = {
  caseId: string
  workload: "isolated-latency" | "transcript-size-latency" | "progressive-resource" | "resource-control"
  sessionState?: "cold" | "warm"
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
  case: SwitchCase | StartCase | SessionNavigationCase | WorkspacePanelCase
}

type ActiveLaunch = {
  processes: OwnedProcess[]
  readiness: ReadinessReceipt
  clock: Clock
}

type DriverDependencies = {
  hello: Record<string, unknown>
  prepare(params: PrepareParams): Promise<Prepared>
  launch(stateHandle: string, initialSessionId: string): Promise<ActiveLaunch>
  activate(target: Target, readinessTimeoutMs?: number): Promise<Clock>
  executePanelAction?(
    benchmarkCase: WorkspacePanelCase,
    target: Target,
    preset: PublicPanelLoadPreset,
  ): Promise<PanelMeasurement>
  executeSessionNavigation?(
    benchmarkCase: SessionNavigationCase,
    source: Target,
    destination: Target,
    preset?: PublicPanelLoadPreset,
  ): Promise<NavigationMeasurement>
  shutdown(): Promise<ShutdownResult>
}

type PanelMeasurement = Awaited<ReturnType<typeof executeWorkspacePanelAction>>
type NavigationMeasurement = Awaited<ReturnType<typeof executeSessionNavigation>>

/** What a shutdown accounts for: every process it ended, and every one it did not. */
type ShutdownResult = { terminated: OwnedProcess[]; survivors: OwnedProcess[] }

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
  /** Logical session IDs first-visited in the current app process (history returns may reuse them later). */
  let visitedDestinations = new Set<string>()

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
    hello: async () => ({ ...dependencies.hello, scenarios: [...PUBLIC_SCENARIO_IDS] }),
    prepare: async (params) => {
      if (prepared) throw new Error("Claxedo driver is already prepared")
      if (!PUBLIC_SCENARIO_IDS.some((id) => id === params.scenarioId)) {
        throw new Error(`Claxedo does not support scenario ${params.scenarioId}`)
      }
      let panelLoadPresets: PublicPanelLoadPresets | undefined
      if (["session-navigation-v1", "workspace-panel-v1"].includes(params.scenarioId)) {
        if (!params.workspaceFixtureManifest) {
          throw new Error(`Claxedo ${params.scenarioId} requires a workspace fixture manifest`)
        }
        panelLoadPresets = publicPanelLoadPresets({
          scenarioDefinition: params.scenarioDefinition,
          fixture: fixtureEvidence(params.workspaceFixtureManifest),
        })
      }
      prepared = { ...(await dependencies.prepare(params)), ...(panelLoadPresets ? { panelLoadPresets } : {}) }
      preparedScenarioId = params.scenarioId
      return {
        materializationMode: "native-opencode",
        corpusDigestSha256: prepared.materialization.corpusDigestSha256,
        eventSchemaDigestSha256: prepared.materialization.eventSchemaDigestSha256,
        mappingDigestSha256: prepared.materialization.mappingDigestSha256,
        ...(prepared.materialization.workspaceFixtureDigestSha256
          ? { workspaceFixtureDigestSha256: prepared.materialization.workspaceFixtureDigestSha256 }
          : {}),
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
      visitedDestinations = new Set()
      return { ready: true, processes: launch.processes, readiness: launch.readiness }
    },
    execute: async (params) => {
      if (params.scenarioId !== preparedScenarioId) throw new Error("Claxedo execute scenario differs from preparation")
      if (params.scenarioId === "session-navigation-v1") {
        if (
          !active ||
          !("navigationType" in params.case) ||
          params.case.workload !== "session-navigation" ||
          !SESSION_NAVIGATION_TYPES.includes(params.case.navigationType)
        ) {
          throw new Error("Claxedo session-navigation request is incomplete")
        }
        if (!dependencies.executeSessionNavigation) {
          throw new Error("Claxedo session-navigation dependency is missing")
        }
        const source = resolveTarget(params.case.sourceSessionId)
        const destination = resolveTarget(params.case.destinationSessionId)
        const preset = params.case.loadProfile
          ? requirePrepared().panelLoadPresets?.[params.case.loadProfile]
          : undefined
        if (params.case.navigationType === "return-visited-panel-open" && !preset) {
          throw new Error("Claxedo panel-open session navigation requires a declared load profile")
        }
        if (params.case.navigationType === "first-visit") {
          if (visitedDestinations.has(params.case.destinationSessionId)) {
            throw new Error("Claxedo first-visit destination was already displayed in this process")
          }
        } else if (params.case.navigationType === "return-visited-panel-closed") {
          if (!visitedDestinations.has(params.case.destinationSessionId)) {
            throw new Error("Claxedo return navigation requires a prior first-visit of the destination in this process")
          }
        }
        const measured = await dependencies.executeSessionNavigation(params.case, source, destination, preset)
        if (params.case.navigationType === "first-visit") {
          visitedDestinations.add(params.case.destinationSessionId)
        }
        return navigationExecution(params.case.caseId, measured)
      }
      if (params.scenarioId === "workspace-panel-v1") {
        if (
          !active ||
          !("loadProfile" in params.case) ||
          !("action" in params.case) ||
          params.case.workload !== "workspace-panel-interaction" ||
          !WORKSPACE_PANEL_ACTIONS.includes(params.case.action)
        ) {
          throw new Error("Claxedo workspace-panel request is incomplete")
        }
        if (!dependencies.executePanelAction) throw new Error("Claxedo workspace-panel dependency is missing")
        const preset = requirePrepared().panelLoadPresets?.[params.case.loadProfile]
        if (!preset) throw new Error(`Claxedo has no workspace-panel preset ${params.case.loadProfile}`)
        const target = resolveTarget("control")
        const measured = await dependencies.executePanelAction(params.case, target, preset)
        return panelExecution(params.case.caseId, measured)
      }
      if (APP_START_SCENARIO_IDS.includes(params.scenarioId)) {
        if (active) throw new Error("Claxedo app-start requires no running application")
        if (!("startMode" in params.case) || !params.stateHandle)
          throw new Error("Claxedo app-start request is incomplete")
        requireStateHandle(params.stateHandle)
        const launch = await dependencies.launch(params.stateHandle, "control")
        active = true
        return execution(params.case.caseId, launch.clock, withTimingEvidence(launch.readiness, launch.clock.end))
      }
      if (
        !SESSION_SWITCH_SCENARIO_IDS.includes(params.scenarioId) ||
        "startMode" in params.case ||
        "action" in params.case ||
        "navigationType" in params.case
      ) {
        throw new Error(`Claxedo does not support scenario ${params.scenarioId}`)
      }
      if (!active) throw new Error("Claxedo session switching requires a running application")
      const benchmarkCase = params.case
      const destination = resolveTarget(benchmarkCase.destinationSessionId)
      const control = resolveTarget(benchmarkCase.sourceSessionId ?? "control")
      if (benchmarkCase.workload !== "resource-control") {
        if (benchmarkCase.sessionState === "warm") await dependencies.activate(destination)
        await dependencies.activate(control)
      }
      const clock = await dependencies.activate(
        destination,
        benchmarkCase.workload === "resource-control" ? RESOURCE_CONTROL_READINESS_TIMEOUT_MS : undefined,
      )
      return execution(benchmarkCase.caseId, clock, readinessReceipt(clock.end))
    },
    shutdown: async () => {
      const result = await dependencies.shutdown()
      active = false
      visitedDestinations = new Set()
      return result
    },
  }
}

function execution(caseId: string, clock: Clock, readiness: ReadinessReceipt) {
  return { caseId, durationMs: clock.end - clock.start, clock, readiness }
}

function panelExecution(caseId: string, measured: PanelMeasurement) {
  return {
    ...execution(caseId, measured.clock, readinessReceipt(measured.clock.end)),
    timingEvidence: { trustedInputAt: measured.clock.start, trustedInputEvent: "pointerdown" },
    rendererTrace: measured.rendererTrace,
  }
}

function navigationExecution(caseId: string, measured: NavigationMeasurement) {
  return {
    ...execution(caseId, measured.clock, readinessReceipt(measured.clock.end)),
    timingEvidence: { trustedInputAt: measured.clock.start, trustedInputEvent: "pointerdown" },
    ...("rendererTrace" in measured ? { rendererTrace: measured.rendererTrace } : {}),
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
    path.join(import.meta.dir, "public-workspace-panel.ts"),
    path.join(import.meta.dir, "workspace-fixture.ts"),
    path.join(import.meta.dir, "fixture-registration.ts"),
    path.join(import.meta.dir, "opencode-corpus.ts"),
    path.join(import.meta.dir, "with-claxedo-data-directory.ts"),
    path.join(import.meta.dir, "agent-claxedo-launcher.ts"),
    path.join(import.meta.dir, "agent-browser-observer.ts"),
    path.join(import.meta.dir, "agent-cdp-page.ts"),
    path.join(import.meta.dir, "agent-display-contract.ts"),
    path.join(import.meta.dir, "agent-process-family.ts"),
    path.join(import.meta.dir, "idle-process-family.ts"),
  ])
  const buildDigestSha256 = await hashFiles(await applicationBuildFiles(executable))

  let readinessTargets: ReadonlyMap<string, Target> = new Map()
  let workspaceFixture: ReturnType<typeof fixtureEvidence> | undefined
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
    if (!launch) return { terminated: [], survivors: [] }
    const result = await launch.shutdown()
    if (removeState && result.survivors.length === 0 && stateRoot) await rm(stateRoot, { recursive: true, force: true })
    return { terminated: result.terminated, survivors: result.survivors }
  }

  const startState = async (stateRoot: string, disposable: boolean): Promise<ActiveLaunch> => {
    if (current) throw new Error("Claxedo application is already running")
    const targets = [...readinessTargets.values()]
    const control = readinessTargets.get("control")
    if (!control || targets.length === 0) throw new Error("Claxedo control readiness target is missing")
    const ambient = path.join(stateRoot, "ambient")
    const launch = await launchPackagedClaxedo({
      executable,
      isolatedProfilePath: path.join(stateRoot, "profile"),
      dataDirectory: path.join(stateRoot, "data"),
      readinessTargets: [control, ...targets.filter((target) => target.logicalSessionId !== "control")],
      extraEnv: {
        HOME: ambient,
        XDG_CONFIG_HOME: path.join(ambient, "config"),
        XDG_CACHE_HOME: path.join(ambient, "cache"),
      },
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
    }
  }

  return {
    hello: {
      protocolVersion: 1,
      application: { id: "claxedo", name: "Claxedo", version: desktopVersion, buildDigestSha256 },
      driver: { name: "claxedo-reference", version: "1", sourceCommit, digestSha256: driverDigestSha256 },
      sourceEventFormats: ["opencode-event-v1", "opencode-event-v2"],
      materializationModes: ["native-opencode"],
      guiFramework: "electron",
    },
    prepare: async (params) => {
      const runRoot = path.join(path.resolve(params.runDirectory), "driver-state", "claxedo")
      attemptsRoot = path.join(runRoot, "attempts")
      const cacheRoot = params.workspaceFixtureManifest ? undefined : process.env.AGENT_APP_BENCHMARK_STATE_CACHE
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
        ...(params.workspaceFixtureManifest
          ? {
              workspaceFixtureManifest: params.workspaceFixtureManifest,
              expectedWorkspaceFixtureDigestSha256: params.workspaceFixtureDigestSha256,
            }
          : {}),
      })
      workspaceFixture = params.workspaceFixtureManifest ? fixtureEvidence(params.workspaceFixtureManifest) : undefined
      readinessTargets = materialization.readinessTargets
      const seedInitializedState = async () => {
        await cp(p0, p1, { recursive: true, errorOnExist: true, mode: fsConstants.COPYFILE_FICLONE })
        await startState(p1, false)
        const initialized = await closeCurrent()
        if (initialized.survivors.length > 0) throw new Error("Claxedo P1 initialization left a surviving process")
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
      const result = await measureSessionActivation(current.page, target, { readinessTimeoutMs })
      if (result.state !== "exact") throw new Error(`Claxedo session activation failed: ${result.reason}`)
      return {
        kind: "single-monotonic-clock",
        clock: "claxedo-renderer-performance",
        start: result.trustedEventAtMs,
        end: result.paintedAtMs,
      }
    },
    executePanelAction: async (benchmarkCase, target, preset) => {
      if (!current || !workspaceFixture) throw new Error("Claxedo public panel fixture is not prepared")
      if (!(await sessionRootVisible(current.page, target.sessionId))) {
        throw new Error("Claxedo workspace-panel action is not on the control session")
      }
      return executeWorkspacePanelAction({
        page: current.page,
        benchmarkCase,
        fixture: workspaceFixture,
        preset,
      })
    },
    executeSessionNavigation: async (benchmarkCase, source, destination, preset) => {
      if (!current || !workspaceFixture) throw new Error("Claxedo public panel fixture is not prepared")
      return executeSessionNavigation({
        page: current.page,
        benchmarkCase,
        source,
        destination,
        fixture: workspaceFixture,
        preset,
      })
    },
    shutdown: closeCurrent,
  }
}

/**
 * Claxedo keeps previously visited session panes mounted, so the first session
 * root in the DOM is not necessarily the focused one. The control-session guard
 * therefore asks for the root that carries the target id and requires it to be
 * laid out and visible, the same identity check the readiness observer uses.
 */
async function sessionRootVisible(
  page: { evaluate: (fn: (id: string) => unknown, id: string) => Promise<unknown> },
  sessionId: string,
) {
  return readFlag(await page.evaluate((id) => {
    const root = document.querySelector<HTMLElement>(
      `[data-testid="session-page-root"][data-session-id="${CSS.escape(id)}"]`,
    )
    if (!root) return false
    const rect = root.getBoundingClientRect()
    const style = getComputedStyle(root)
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
  }, sessionId))
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
async function writePreparedCache(cacheRoot: string, materialization: ClaxedoPublicMaterialization) {
  await writeFile(
    path.join(cacheRoot, PREPARED_CACHE_FILE),
    JSON.stringify({ ...materialization, readinessTargets: [...materialization.readinessTargets] }),
    { mode: 0o600 },
  )
}

async function readPreparedCache(
  cacheRoot: string,
  corpusDigestSha256: string,
): Promise<ClaxedoPublicMaterialization | undefined> {
  const text = await readFile(path.join(cacheRoot, PREPARED_CACHE_FILE), "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  const record: unknown = JSON.parse(text)
  if (!isRecord(record) || record.corpusDigestSha256 !== corpusDigestSha256 || !Array.isArray(record.readinessTargets))
    throw new Error("Claxedo prepared-state cache belongs to a different corpus")
  return {
    ...(record as Omit<ClaxedoPublicMaterialization, "readinessTargets">),
    readinessTargets: new Map(record.readinessTargets as [string, Target & { logicalSessionId: string; workspaceDirectory: string }][]),
  }
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

const stringList = (record: Record<string, unknown>, key: string): string[] | undefined => {
  const value = record[key]
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return undefined
  return value.filter((entry) => typeof entry === "string")
}

/** Read the fixture's generation parameters, which decide every file it holds. */
function parseWorkspaceLoad(load: Record<string, unknown> | undefined): WorkspaceLoad | undefined {
  if (!load || load.generator !== "agent-app-workspace-v1") return undefined
  const counts = [
    "directoryCount",
    "sourceFileCount",
    "sourceFileBytes",
    "changedFileCount",
    "diffHunksPerFile",
    "diffLinesPerHunk",
    "openFileTabCount",
  ] as const
  const read = counts.map((name) => [name, numberField(load, name)] as const)
  if (read.some(([, value]) => value === undefined)) return undefined
  return {
    generator: "agent-app-workspace-v1",
    directoryCount: numberField(load, "directoryCount") ?? 0,
    sourceFileCount: numberField(load, "sourceFileCount") ?? 0,
    sourceFileBytes: numberField(load, "sourceFileBytes") ?? 0,
    changedFileCount: numberField(load, "changedFileCount") ?? 0,
    diffHunksPerFile: numberField(load, "diffHunksPerFile") ?? 0,
    diffLinesPerHunk: numberField(load, "diffLinesPerHunk") ?? 0,
    openFileTabCount: numberField(load, "openFileTabCount") ?? 0,
  }
}

/**
 * Read an unvalidated `workspaceFixtureManifest` from the driver protocol.
 *
 * The benchmark SDK's own `verifyWorkspaceFixtureManifest` takes an
 * already-typed manifest, so it cannot be the boundary for JSON off the wire.
 * This checks the fields the harness reads — the file identities, the changed
 * and open path lists, and the digests that make the fixture reproducible —
 * and rejects anything else, instead of asserting the shape and failing later
 * inside a scenario.
 */
function parseWorkspaceFixtureManifest(value: unknown): WorkspaceFixtureManifest {
  if (!isRecord(value)) throw new Error("Claxedo driver requires an object workspaceFixtureManifest")
  const seed = textField(value, "seed")
  const manifestDigestSha256 = textField(value, "manifestDigestSha256")
  const directories = stringList(value, "directories")
  const changedFilePaths = stringList(value, "changedFilePaths")
  const openFilePaths = stringList(value, "openFilePaths")
  const load = parseWorkspaceLoad(recordField(value, "load"))
  const rawFiles = recordsField(value, "files")
  if (
    value.schemaVersion !== 1 ||
    value.generator !== "agent-app-workspace-v1" ||
    seed === undefined ||
    manifestDigestSha256 === undefined ||
    !directories ||
    !changedFilePaths ||
    !openFilePaths ||
    !load ||
    !rawFiles
  ) {
    throw new Error("Claxedo driver workspaceFixtureManifest does not match agent-app-workspace-v1")
  }
  const files = rawFiles.map((file) => {
    const filePath = textField(file, "path")
    const byteLength = numberField(file, "byteLength")
    const initialDigestSha256 = textField(file, "initialDigestSha256")
    const currentDigestSha256 = textField(file, "currentDigestSha256")
    const hunks = (recordsField(file, "hunks") ?? []).map((hunk) => ({
      startLine: numberField(hunk, "startLine") ?? -1,
      lineCount: numberField(hunk, "lineCount") ?? -1,
    }))
    if (
      filePath === undefined ||
      byteLength === undefined ||
      typeof file.changed !== "boolean" ||
      initialDigestSha256 === undefined ||
      currentDigestSha256 === undefined ||
      hunks.some((hunk) => hunk.startLine < 0 || hunk.lineCount < 0)
    ) {
      throw new Error("Claxedo driver workspaceFixtureManifest has an unreadable file entry")
    }
    return { path: filePath, byteLength, changed: file.changed, hunks, initialDigestSha256, currentDigestSha256 }
  })
  return {
    schemaVersion: 1,
    generator: "agent-app-workspace-v1",
    seed,
    load,
    directories,
    files,
    changedFilePaths,
    openFilePaths,
    manifestDigestSha256,
  }
}

// The protocol hands these three readers whatever the caller sent. They take
// `unknown` and check it, rather than being declared as already-validated
// records and asserted into at the call site.
function prepareParams(params: unknown): PrepareParams {
  if (!isRecord(params)) throw new Error("Claxedo driver prepare requires an object")
  const workspaceFixtureManifest =
    params.workspaceFixtureManifest === undefined
      ? undefined
      : parseWorkspaceFixtureManifest(params.workspaceFixtureManifest)
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
    ...(typeof params.fixtureSeed === "string" ? { fixtureSeed: params.fixtureSeed } : {}),
    ...(workspaceFixtureManifest ? { workspaceFixtureManifest } : {}),
    ...(typeof params.workspaceFixtureDigestSha256 === "string"
      ? { workspaceFixtureDigestSha256: params.workspaceFixtureDigestSha256 }
      : {}),
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
 * Read an unvalidated benchmark case from the driver protocol.
 *
 * The four case shapes are discriminated by `workload` (or, for the start
 * case, by `startMode`). Asserting the union here let a malformed case reach a
 * scenario and fail as a missing session id mid-measurement; reading it here
 * names the bad field at the protocol boundary.
 */
function parseBenchmarkCase(value: unknown): SwitchCase | StartCase | SessionNavigationCase | WorkspacePanelCase {
  if (!isRecord(value)) throw new Error("Claxedo driver requires a benchmark case")
  const caseId = textField(value, "caseId")
  if (caseId === undefined) throw new Error("Claxedo driver benchmark case is missing caseId")
  const workload = textField(value, "workload")

  if (workload === "session-navigation") {
    const navigationType = SESSION_NAVIGATION_TYPES.find((entry) => entry === textField(value, "navigationType"))
    const trend = textField(value, "trend")
    const transcriptBytes = numberField(value, "transcriptBytes")
    const sourceSessionId = textField(value, "sourceSessionId")
    const destinationSessionId = textField(value, "destinationSessionId")
    const loadProfile = PUBLIC_PANEL_LOAD_PROFILES.find((entry) => entry === textField(value, "loadProfile"))
    if (
      !navigationType ||
      (trend !== "history-size" && trend !== "panel-load") ||
      transcriptBytes === undefined ||
      sourceSessionId === undefined ||
      destinationSessionId === undefined
    ) {
      throw new Error(`Claxedo driver session-navigation case ${caseId} is incomplete`)
    }
    return {
      caseId,
      workload,
      trend,
      navigationType,
      transcriptBytes,
      sourceSessionId,
      destinationSessionId,
      ...(loadProfile ? { loadProfile } : {}),
    }
  }

  if (workload === "workspace-panel-interaction") {
    const action = WORKSPACE_PANEL_ACTIONS.find((entry) => entry === textField(value, "action"))
    const loadProfile = PUBLIC_PANEL_LOAD_PROFILES.find((entry) => entry === textField(value, "loadProfile"))
    if (!action || !loadProfile) throw new Error(`Claxedo driver workspace-panel case ${caseId} is incomplete`)
    return { caseId, workload, action, loadProfile }
  }

  if (
    workload === "isolated-latency" ||
    workload === "transcript-size-latency" ||
    workload === "progressive-resource" ||
    workload === "resource-control"
  ) {
    const destinationSessionId = textField(value, "destinationSessionId")
    if (destinationSessionId === undefined) {
      throw new Error(`Claxedo driver switch case ${caseId} is missing destinationSessionId`)
    }
    const sessionState = textField(value, "sessionState")
    const sourceSessionId = textField(value, "sourceSessionId")
    return {
      caseId,
      workload,
      destinationSessionId,
      ...(sessionState === "cold" || sessionState === "warm" ? { sessionState } : {}),
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
