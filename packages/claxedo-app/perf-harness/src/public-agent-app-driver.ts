#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import { access, cp, mkdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { serveDriver, type DriverHandlers } from "agent-app-benchmark/driver-sdk"
import type { WorkspaceFixtureManifest } from "agent-app-benchmark/driver-sdk"
import { measureSessionActivation, type SessionReadinessTarget } from "./agent-browser-observer"
import { launchPackagedClaxedo, type ClaxedoLaunch } from "./agent-claxedo-launcher"
import { materializeClaxedoPublicCorpus, type ClaxedoPublicMaterialization } from "./public-corpus-materializer"
import {
  executeWorkspacePanelAction,
  executeWorkspacePanelActionV2,
  executeSessionNavigation,
  executeWorkspacePanelSwitch,
  fixtureEvidence,
  publicPanelLoadPresets,
  type PanelActionCase,
  type PanelSwitchCase,
  type PanelTarget,
  type PublicPanelLoadPreset,
  type PublicPanelLoadPresets,
  type SessionNavigationCase,
  type WorkspacePanelV2Case,
} from "./public-workspace-panel"

type OwnedProcess = {
  pid: number
  startTimeMs: number
  owner: "application"
  category: string
  role?: "main"
}

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

type PrepareParams = {
  scenarioId: string
  scenarioDigestSha256: string
  corpusDirectory: string
  corpusManifestPath: string
  corpusDigestSha256: string
  corpusDefinitionDigestSha256: string
  eventSchemaDigestSha256: string
  runDirectory: string
  scenarioDefinition?: Record<string, unknown>
  fixtureSeed?: string
  workspaceFixtureManifest?: WorkspaceFixtureManifest
  workspaceFixtureDigestSha256?: string
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
  case: SwitchCase | StartCase | PanelActionCase | PanelSwitchCase | SessionNavigationCase | WorkspacePanelV2Case
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
  activate(target: Target): Promise<Clock>
  executePanelAction?(benchmarkCase: PanelActionCase, target: Target): Promise<PanelMeasurement>
  executePanelActionV2?(
    benchmarkCase: WorkspacePanelV2Case,
    target: Target,
    preset: PublicPanelLoadPreset,
  ): Promise<PanelMeasurement>
  executeSessionNavigation?(
    benchmarkCase: SessionNavigationCase,
    source: Target,
    destination: Target,
    preset?: PublicPanelLoadPreset,
  ): Promise<NavigationMeasurement>
  executePanelSwitch?(benchmarkCase: PanelSwitchCase, source: Target, destination: Target): Promise<PanelMeasurement>
  shutdown(): Promise<{ terminated: OwnedProcess[]; survivors: OwnedProcess[] }>
}

type PanelMeasurement = Awaited<ReturnType<typeof executeWorkspacePanelAction>>
type NavigationMeasurement = Awaited<ReturnType<typeof executeSessionNavigation>>

export type ClaxedoPublicDriver = {
  hello(): Promise<Record<string, unknown>>
  prepare(params: PrepareParams): Promise<Record<string, unknown>>
  launch(params: LaunchParams): Promise<Record<string, unknown>>
  execute(params: ExecuteParams): Promise<Record<string, unknown>>
  shutdown(): Promise<Record<string, unknown>>
}

export function createClaxedoPublicDriver(dependencies: DriverDependencies): ClaxedoPublicDriver {
  let prepared: Prepared | undefined
  let active = false
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
    hello: async () => dependencies.hello,
    prepare: async (params) => {
      if (prepared) throw new Error("Claxedo driver is already prepared")
      let panelLoadPresets: PublicPanelLoadPresets | undefined
      if (["session-navigation-v1", "workspace-panel-v2"].includes(params.scenarioId)) {
        if (!params.workspaceFixtureManifest) {
          throw new Error(`Claxedo ${params.scenarioId} requires a workspace fixture manifest`)
        }
        panelLoadPresets = publicPanelLoadPresets({
          scenarioDefinition: params.scenarioDefinition,
          fixture: fixtureEvidence(params.workspaceFixtureManifest),
        })
      }
      prepared = { ...await dependencies.prepare(params), ...(panelLoadPresets ? { panelLoadPresets } : {}) }
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
      if (params.scenarioId === "session-navigation-v1") {
        if (!active || !("navigationType" in params.case)) {
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
      if (params.scenarioId === "workspace-panel-v2") {
        if (!active || !("loadProfile" in params.case) || !("action" in params.case)) {
          throw new Error("Claxedo workspace-panel-v2 request is incomplete")
        }
        if (!dependencies.executePanelActionV2) throw new Error("Claxedo workspace-panel-v2 dependency is missing")
        const preset = requirePrepared().panelLoadPresets?.[params.case.loadProfile]
        if (!preset) throw new Error(`Claxedo has no workspace-panel-v2 preset ${params.case.loadProfile}`)
        const target = resolveTarget("control")
        const measured = await dependencies.executePanelActionV2(params.case, target, preset)
        return panelExecution(params.case.caseId, measured, true)
      }
      if (params.scenarioId === "workspace-panel-v1") {
        if (!active || !("action" in params.case) || params.case.workload !== "workspace-panel-action") {
          throw new Error("Claxedo workspace-panel request is incomplete")
        }
        if (!dependencies.executePanelAction) throw new Error("Claxedo workspace-panel dependency is missing")
        const target = resolveTarget("control")
        const measured = await dependencies.executePanelAction(params.case, target)
        return panelExecution(params.case.caseId, measured)
      }
      if (params.scenarioId === "session-switch-workspace-panel-v1") {
        if (!active || !("panelProfile" in params.case))
          throw new Error("Claxedo session-switch-workspace-panel request is incomplete")
        if (!dependencies.executePanelSwitch)
          throw new Error("Claxedo session-switch-workspace-panel dependency is missing")
        const source = resolveTarget(params.case.sourceSessionId)
        const destination = resolveTarget(params.case.destinationSessionId)
        const measured = await dependencies.executePanelSwitch(params.case, source, destination)
        return panelExecution(params.case.caseId, measured)
      }
      if (["app-start-v1", "app-start-v3"].includes(params.scenarioId)) {
        if (active) throw new Error("Claxedo app-start requires no running application")
        if (!("startMode" in params.case) || !params.stateHandle)
          throw new Error("Claxedo app-start request is incomplete")
        requireStateHandle(params.stateHandle)
        const launch = await dependencies.launch(params.stateHandle, "control")
        active = true
        return execution(
          params.case.caseId,
          launch.clock,
          params.scenarioId === "app-start-v3" ? withTimingEvidence(launch.readiness, launch.clock.end) : launch.readiness,
        )
      }
      if (
        !["session-switch-v1", "session-switch-v3"].includes(params.scenarioId) ||
        "startMode" in params.case ||
        "action" in params.case ||
        "panelProfile" in params.case ||
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
      const clock = await dependencies.activate(destination)
      return execution(
        benchmarkCase.caseId,
        clock,
        readinessReceipt(params.scenarioId === "session-switch-v3" ? clock.end : undefined),
      )
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

function panelExecution(caseId: string, measured: PanelMeasurement, includeTrustedInputProof = false) {
  return {
    ...execution(caseId, measured.clock, readinessReceipt(measured.clock.end)),
    ...(includeTrustedInputProof ? {
      timingEvidence: { trustedInputAt: measured.clock.start, trustedInputEvent: "pointerdown" },
    } : {}),
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
  return { ...receipt, checks: receipt.checks.map((check) => ({ ...check, observedAt: check.observedAt ?? observedAt })) }
}

async function makeDefaultDependencies(): Promise<DriverDependencies> {
  const repoRoot = path.resolve(import.meta.dir, "../../../..")
  const executable = await discoverPackagedExecutable()
  const desktopPackage = JSON.parse(
    await readFile(path.join(repoRoot, "packages/claxedo-desktop/package.json"), "utf8"),
  ) as { version?: unknown }
  if (typeof desktopPackage.version !== "string" || desktopPackage.version.length === 0)
    throw new Error("Claxedo desktop version is missing")
  const sourceCommit = await gitOutput(repoRoot, ["rev-parse", "HEAD"])
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("Claxedo source revision is invalid")
  const driverDigestSha256 = await hashFiles([
    import.meta.path,
    path.join(import.meta.dir, "public-corpus-materializer.ts"),
    path.join(import.meta.dir, "public-workspace-panel.ts"),
    path.join(import.meta.dir, "agent-claxedo-launcher.ts"),
    path.join(import.meta.dir, "agent-browser-observer.ts"),
  ])
  const buildDigestSha256 = await hashFiles(await applicationBuildFiles(executable))

  let readinessTargets: ReadonlyMap<string, Target> = new Map()
  let workspaceFixture: ReturnType<typeof fixtureEvidence> | undefined
  let current: ClaxedoLaunch | undefined
  let activeStateRoot: string | undefined
  let removeActiveState = false
  let attemptSequence = 0

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
    return { terminated: result.terminated as OwnedProcess[], survivors: result.survivors as OwnedProcess[] }
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
      processes: [{ ...(launch.process as OwnedProcess), role: "main" }],
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
      application: { id: "claxedo", name: "Claxedo", version: desktopPackage.version, buildDigestSha256 },
      driver: { name: "claxedo-reference", version: "1", sourceCommit, digestSha256: driverDigestSha256 },
      scenarios: [
        "app-start-v1",
        "session-switch-v1",
        "app-start-v3",
        "session-switch-v3",
        "workspace-panel-v1",
        "session-switch-workspace-panel-v1",
        "session-navigation-v1",
        "workspace-panel-v2",
      ],
      sourceEventFormats: ["opencode-event-v1", "opencode-event-v2"],
      materializationModes: ["native-opencode"],
      guiFramework: "electron",
    },
    prepare: async (params) => {
      const privateRoot = path.join(path.resolve(params.runDirectory), "driver-state", "claxedo")
      const p0 = path.join(privateRoot, "P0")
      const p1 = path.join(privateRoot, "P1")
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
      await cp(p0, p1, { recursive: true, errorOnExist: true, mode: fsConstants.COPYFILE_FICLONE })
      await startState(p1, false)
      const initialized = await closeCurrent()
      if (initialized.survivors.length > 0) throw new Error("Claxedo P1 initialization left a surviving process")
      return { materialization, stateHandles: { P0: p0, P1: p1 } }
    },
    launch: async (stateHandle, initialSessionId) => {
      if (initialSessionId !== "control") throw new Error("Claxedo public launch must begin at the control session")
      const attempt = path.join(path.dirname(stateHandle), "attempts", String(attemptSequence++))
      await mkdir(path.dirname(attempt), { recursive: true, mode: 0o700 })
      await cp(stateHandle, attempt, { recursive: true, errorOnExist: true, mode: fsConstants.COPYFILE_FICLONE })
      try {
        return await startState(attempt, true)
      } catch (error) {
        await rm(attempt, { recursive: true, force: true })
        throw error
      }
    },
    activate: async (target) => {
      if (!current) throw new Error("Claxedo renderer is not running")
      const result = await measureSessionActivation(current.page, target)
      if (result.state !== "exact") throw new Error(`Claxedo session activation failed: ${result.reason}`)
      return {
        kind: "single-monotonic-clock",
        clock: "claxedo-renderer-performance",
        start: result.trustedEventAtMs,
        end: result.paintedAtMs,
      }
    },
    executePanelAction: async (benchmarkCase, target) => {
      if (!current || !workspaceFixture) throw new Error("Claxedo public panel fixture is not prepared")
      const activeTarget = await current.page.evaluate(() =>
        document.querySelector<HTMLElement>("[data-session-id][data-session-active='true']")?.dataset.sessionId,
      )
      if (activeTarget && activeTarget !== target.sessionId)
        throw new Error("Claxedo workspace-panel action is not on the control session")
      return executeWorkspacePanelAction({ page: current.page as never, benchmarkCase, fixture: workspaceFixture })
    },
    executePanelActionV2: async (benchmarkCase, target, preset) => {
      if (!current || !workspaceFixture) throw new Error("Claxedo public panel fixture is not prepared")
      const activeTarget = await current.page.evaluate(() =>
        document.querySelector<HTMLElement>("[data-session-id][data-session-active='true']")?.dataset.sessionId,
      )
      if (activeTarget && activeTarget !== target.sessionId) {
        throw new Error("Claxedo workspace-panel-v2 action is not on the control session")
      }
      return executeWorkspacePanelActionV2({
        page: current.page as never,
        benchmarkCase,
        fixture: workspaceFixture,
        preset,
      })
    },
    executeSessionNavigation: async (benchmarkCase, source, destination, preset) => {
      if (!current || !workspaceFixture) throw new Error("Claxedo public panel fixture is not prepared")
      return executeSessionNavigation({
        page: current.page as never,
        benchmarkCase,
        source,
        destination,
        fixture: workspaceFixture,
        preset,
      })
    },
    executePanelSwitch: async (benchmarkCase, source, destination) => {
      if (!current || !workspaceFixture) throw new Error("Claxedo public panel fixture is not prepared")
      return executeWorkspacePanelSwitch({
        page: current.page as never,
        benchmarkCase,
        source,
        destination,
        fixture: workspaceFixture,
      })
    },
    shutdown: closeCurrent,
  }
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

function prepareParams(params: Record<string, unknown>): PrepareParams {
  const workspaceFixtureManifest = params.workspaceFixtureManifest
  if (
    workspaceFixtureManifest !== undefined &&
    (!workspaceFixtureManifest || typeof workspaceFixtureManifest !== "object" || Array.isArray(workspaceFixtureManifest))
  ) {
    throw new Error("Claxedo driver requires an object workspaceFixtureManifest")
  }
  return {
    scenarioId: requiredString(params, "scenarioId"),
    scenarioDigestSha256: requiredString(params, "scenarioDigestSha256"),
    corpusDirectory: requiredString(params, "corpusDirectory"),
    corpusManifestPath: requiredString(params, "corpusManifestPath"),
    corpusDigestSha256: requiredString(params, "corpusDigestSha256"),
    corpusDefinitionDigestSha256: requiredString(params, "corpusDefinitionDigestSha256"),
    eventSchemaDigestSha256: requiredString(params, "eventSchemaDigestSha256"),
    runDirectory: requiredString(params, "runDirectory"),
    ...(params.scenarioDefinition && typeof params.scenarioDefinition === "object" && !Array.isArray(params.scenarioDefinition)
      ? { scenarioDefinition: params.scenarioDefinition as Record<string, unknown> }
      : {}),
    ...(typeof params.fixtureSeed === "string" ? { fixtureSeed: params.fixtureSeed } : {}),
    ...(workspaceFixtureManifest
      ? { workspaceFixtureManifest: workspaceFixtureManifest as WorkspaceFixtureManifest }
      : {}),
    ...(typeof params.workspaceFixtureDigestSha256 === "string"
      ? { workspaceFixtureDigestSha256: params.workspaceFixtureDigestSha256 }
      : {}),
  }
}

function launchParams(params: Record<string, unknown>): LaunchParams {
  return {
    scenarioId: requiredString(params, "scenarioId"),
    stateHandle: requiredString(params, "stateHandle"),
    initialSessionId: requiredString(params, "initialSessionId"),
    groupId: requiredString(params, "groupId"),
  }
}

function executeParams(params: Record<string, unknown>): ExecuteParams {
  if (!params.case || typeof params.case !== "object" || Array.isArray(params.case))
    throw new Error("Claxedo driver requires a benchmark case")
  return {
    scenarioId: requiredString(params, "scenarioId"),
    ...(typeof params.stateHandle === "string" ? { stateHandle: params.stateHandle } : {}),
    case: params.case as SwitchCase | StartCase | PanelActionCase | PanelSwitchCase | SessionNavigationCase | WorkspacePanelV2Case,
  }
}

export async function runClaxedoPublicDriver() {
  const driver = createClaxedoPublicDriver(await makeDefaultDependencies())
  const handlers: DriverHandlers = {
    hello: async () => driver.hello(),
    prepare: async (params) => driver.prepare(prepareParams(params as unknown as Record<string, unknown>)),
    launch: async (params) => driver.launch(launchParams(params)),
    execute: async (params) => driver.execute(executeParams(params)),
    shutdown: async () => driver.shutdown(),
  }
  const cleanup = async () => {
    const result = await driver.shutdown()
    if ((result.survivors as unknown[]).length > 0) throw new Error("Claxedo driver cleanup left a surviving process")
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
