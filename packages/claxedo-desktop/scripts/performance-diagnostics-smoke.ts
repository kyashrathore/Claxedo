#!/usr/bin/env bun

import { cpus, tmpdir } from "node:os"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import type { LocalDiagnostics } from "@claxedo/app/process-diagnostics-contract"
import { createServer } from "node:net"
import { createInterface } from "node:readline"
import pidtree from "pidtree"

import { createProcessMetricsSource } from "../src/main/diagnostics/process-metrics-source"
import { createIsolatedPosixProcessMetricsWorker } from "../src/main/diagnostics/process-metrics-worker"
import type { Pidusage } from "../src/main/diagnostics/process-metrics-worker-runtime"
import { createProfiler, type DiagnosticsSource } from "../src/main/diagnostics/profiler"
import type { ElectronDiagnosticsSource } from "../src/main/diagnostics/electron-source"

export const DIAGNOSTICS_CPU_OVERHEAD_BUDGET = 1
export const DIAGNOSTICS_RETAINED_BYTES_BUDGET = 20 * 1024 * 1024
const SECRET_SENTINEL = "claxedo-diagnostics-secret-must-not-cross"
const packageUsage = createRequire(import.meta.url)("pidusage") as Pidusage

export type DiagnosticsSmokeEvidence = {
  mode: "source" | "packaged"
  platform: NodeJS.Platform
  architecture: NodeJS.Architecture
  startupHistory: boolean
  topContributor: string
  serverSeparated: boolean
  memoryGrowth: boolean
  churnUnmeasured: boolean
  redacted: boolean
  actionSafety:
    | "verified"
    | "read-only-by-platform"
    | "packaged-read-only"
    | "packaged-invalid-token-rejected"
  retainedBytes: number
  cpuOverheadPercentagePoints?: number
  profilerStats?: Record<string, number>
  sourceHealth?: Record<string, LocalDiagnostics.SourceStatus["state"]>
  renderedProduct?: {
    collectorState: boolean
    timeline: boolean
    contributorRanking: boolean
    lifecycle: boolean
    intervalIdentified: boolean
    electronContributor: boolean
    serverContributor: boolean
    sidecarExpected: boolean
    sidecarContributor: boolean
    memoryGrowthContributor: boolean
    limitationDisclosed: boolean
    churnEvidence: boolean
  }
}

export function evaluateDiagnosticsEvidence(input: {
  snapshot: LocalDiagnostics.RetainedSnapshot
  stats: Record<string, number>
  platform: NodeJS.Platform
  actionSafety: DiagnosticsSmokeEvidence["actionSafety"]
  cpuOverheadPercentagePoints?: number
  requireServer?: boolean
}) {
  const serialized = JSON.stringify(input.snapshot)
  const contributor = input.snapshot.interval.contributors.find(
    (item) => item.ownerId && reading(item.peakCpuMachinePercent) > 0,
  )
  const server = input.snapshot.owners.find((owner) => owner.kind === "server")
  const serverProcess = server
    ? input.snapshot.processes.find((process) => process.ownerId === server.id && process.role === "server")
    : undefined
  const unmeasured = input.snapshot.markers.some(
    (marker) => marker.type === "churn" && marker.resourceMeasurement.state === "unmeasured",
  )
  const memoryGrowth = input.snapshot.interval.contributors.some(
    (item) => byteReading(item.rssChangeBytes) > 0,
  )
  const evidence: DiagnosticsSmokeEvidence = {
    mode: "source",
    platform: input.platform,
    architecture: process.arch,
    startupHistory:
      input.snapshot.markers.some(
        (marker) => marker.type === "lifecycle" && marker.event === "profiler-started",
      ) && input.snapshot.samples.some((sample) => sample.at < input.snapshot.capturedAt),
    topContributor:
      input.snapshot.owners.find((owner) => owner.id === contributor?.ownerId)?.label ?? "",
    serverSeparated: !!serverProcess,
    memoryGrowth,
    churnUnmeasured: unmeasured,
    redacted: !serialized.includes(SECRET_SENTINEL),
    actionSafety: input.actionSafety,
    retainedBytes: input.stats.retainedBytes ?? serialized.length,
    ...(input.cpuOverheadPercentagePoints === undefined
      ? {}
      : { cpuOverheadPercentagePoints: input.cpuOverheadPercentagePoints }),
    profilerStats: input.stats,
  }
  const failures = [
    !evidence.startupHistory ? "retained startup history was missing" : undefined,
    !evidence.topContributor ? "no measured logical contributor was ranked" : undefined,
    input.requireServer && !evidence.serverSeparated
      ? "Claxedo server was not separated from Electron main"
      : undefined,
    !evidence.memoryGrowth ? "no logical contributor recorded positive RSS growth" : undefined,
    !evidence.churnUnmeasured ? "sub-cadence unmeasured churn was missing" : undefined,
    !evidence.redacted ? "a secret sentinel crossed the diagnostics contract" : undefined,
    evidence.retainedBytes > DIAGNOSTICS_RETAINED_BYTES_BUDGET
      ? `retained bytes ${String(evidence.retainedBytes)} exceeded ${String(DIAGNOSTICS_RETAINED_BYTES_BUDGET)}`
      : undefined,
    input.cpuOverheadPercentagePoints !== undefined &&
    input.cpuOverheadPercentagePoints > DIAGNOSTICS_CPU_OVERHEAD_BUDGET
      ? `steady profiler CPU overhead ${input.cpuOverheadPercentagePoints.toFixed(3)}pp exceeded ${String(DIAGNOSTICS_CPU_OVERHEAD_BUDGET)}pp`
      : undefined,
  ].filter((item): item is string => !!item)
  return { evidence, failures }
}

export async function runSourceSmoke() {
  assertExpectedArchitecture()
  if (process.platform !== "darwin" && process.platform !== "linux" && process.platform !== "win32") {
    throw new Error(`Unsupported diagnostics smoke platform: ${process.platform}`)
  }
  const cpuMeasurements: number[] = []
  for (const enabled of [false, true, true, false]) {
    cpuMeasurements.push(await measureDiagnosticsTreeCpu(enabled))
  }
  const fixture = Bun.spawn({
    cmd: [
      process.execPath,
      "-e",
      "const memory=[];let ticks=0;const grow=setInterval(()=>{memory.push(Buffer.alloc(8*1024*1024,1));const end=Date.now()+120;while(Date.now()<end)Math.sqrt(Math.random()*1e9);if(++ticks===8)clearInterval(grow)},200);setTimeout(()=>memory[0]?.[0],30000)",
    ],
    env: { ...process.env, CLAXEDO_DIAGNOSTICS_SECRET_SENTINEL: SECRET_SENTINEL },
    stdout: "ignore",
    stderr: "ignore",
  })
  const source = createProcessMetricsSource({
    platform: process.platform,
    electron: emptyElectronSource(),
    ...(process.platform === "darwin" || process.platform === "linux"
      ? {
          worker: createIsolatedPosixProcessMetricsWorker({
            platform: process.platform,
            workerPath: resolve(import.meta.dirname, "../out/main/process-metrics-worker.js"),
          }),
        }
      : {}),
  })
  const profiler = createProfiler({
    source,
    startupDurationMs: 0,
    steadyIntervalMs: 2_000,
  })
  const ownerGeneration = crypto.randomUUID()
  const ownerId = "diagnostics-smoke-harness"
  const startedAt = Date.now()
  profiler.recordOwnerEvent({
    type: "owner-registered",
    at: startedAt,
    binding: { pid: process.pid, launchId: "smoke", generation: "smoke" },
    descriptor: {
      ownerId,
      ownerGeneration,
      ownerOperationId: crypto.randomUUID(),
      launchId: crypto.randomUUID(),
      kind: "harness",
      role: "harness",
      label: "Diagnostics smoke harness",
      pid: fixture.pid,
      harnessId: "diagnostics-smoke",
      attributionConfidence: "direct",
      capabilities: { stopGracefully: true, killOwnedTree: true },
    },
  }, async () => {
    fixture.kill()
    return "completed"
  })
  const churnGeneration = crypto.randomUUID()
  profiler.recordOwnerEvent({
    type: "owner-registered",
    at: startedAt + 1,
    binding: { pid: process.pid, launchId: "smoke", generation: "smoke" },
    descriptor: {
      ownerId: "diagnostics-smoke-short-cli",
      ownerGeneration: churnGeneration,
      ownerOperationId: crypto.randomUUID(),
      launchId: crypto.randomUUID(),
      kind: "cli",
      role: "cli",
      label: "Short diagnostics CLI",
      harnessId: "diagnostics-smoke",
      attributionConfidence: "direct",
      capabilities: { stopGracefully: false, killOwnedTree: false },
    },
  })
  profiler.recordOwnerEvent({
    type: "owner-exited",
    at: startedAt + 25,
    binding: { pid: process.pid, launchId: "smoke", generation: "smoke" },
    ownerId: "diagnostics-smoke-short-cli",
    ownerGeneration: churnGeneration,
    reason: "exited",
    exitCode: 0,
    observedLifetimeMs: 24,
  })

  for (let index = 0; index < 16; index++) {
    await Bun.sleep(200)
    profiler.requestSample("manual")
  }
  const beforeAction = profiler.getSnapshot()
  const processRecord = beforeAction.processes.find((process) => process.ownerId === ownerId)
  const stop = processRecord?.actionEligibility.state === "eligible"
    ? processRecord.actionEligibility.actions.find((grant) => grant.action === "stop")
    : undefined
  const actionSafety = await (async (): Promise<DiagnosticsSmokeEvidence["actionSafety"]> => {
    if (!stop) {
      if (process.platform === "darwin") return "read-only-by-platform"
      throw new Error("Identity-qualified smoke owner did not receive a stop grant")
    }
    const prepared = profiler.prepareAction({ action: "stop", token: stop.token })
    if (!prepared.ok) throw new Error(`Smoke stop token was rejected: ${prepared.result.code}`)
    const result = await profiler.executeAction(prepared.claim)
    if (!result.ok) throw new Error(`Smoke stop failed: ${result.code}`)
    const reused = profiler.prepareAction({ action: "stop", token: stop.token })
    if (reused.ok || reused.result.code !== "invalid-token") {
      throw new Error("Smoke action token was not single-use")
    }
    return "verified"
  })()
  profiler.recordOwnerEvent({
    type: "owner-exited",
    at: Date.now(),
    binding: { pid: process.pid, launchId: "smoke", generation: "smoke" },
    ownerId,
    ownerGeneration,
    reason: "exited",
    observedLifetimeMs: Date.now() - startedAt,
  })
  const result = evaluateDiagnosticsEvidence({
    snapshot: beforeAction,
    stats: profiler.getStats(),
    platform: process.platform,
    actionSafety,
    cpuOverheadPercentagePoints: pairedCpuOverhead(cpuMeasurements),
  })
  profiler.dispose()
  fixture.kill()
  await Promise.race([fixture.exited, Bun.sleep(2_000)])
  if (result.failures.length > 0) throw new Error(result.failures.join("\n"))
  return result.evidence
}

export function pairedCpuOverhead(measurements: number[]) {
  if (measurements.length !== 4 || measurements.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Diagnostics CPU overhead requires four finite non-negative ABBA measurements")
  }
  return Math.max(0, (measurements[1]! + measurements[2]! - measurements[0]! - measurements[3]!) / 2)
}

export async function runPackagedSmoke() {
  assertExpectedArchitecture()
  const executable = process.env.CLAXEDO_DIAGNOSTICS_APP_EXECUTABLE ?? await discoverPackagedExecutable()
  const userData = await mkdtemp(join(tmpdir(), "claxedo-diagnostics-smoke-"))
  await mkdir(join(userData, "data"))
  const debugPort = await availablePort()
  const application = Bun.spawn({
    cmd: [executable, `--remote-debugging-port=${String(debugPort)}`],
    env: {
      ...process.env,
      CLAXEDO_DESKTOP_USER_DATA_DIR: userData,
      CLAXEDO_DATA_DIR: join(userData, "data"),
      CLAXEDO_DIAGNOSTICS_SECRET_SENTINEL: SECRET_SENTINEL,
      CLAXEDO_DIAGNOSTICS_PACKAGED_SMOKE: "1",
    },
    stdout: "inherit",
    stderr: "inherit",
  })
  try {
    const client = await connectToPackagedApp(debugPort, application)
    try {
      await waitForMainWindow(client)
      const snapshot = await waitForSnapshot(client)
      const serialized = JSON.stringify(snapshot)
      if (serialized.includes(SECRET_SENTINEL)) throw new Error("Packaged snapshot leaked the secret sentinel")
      const startupHistory =
        snapshot.markers.some(
          (marker) => marker.type === "lifecycle" && marker.event === "profiler-started",
        ) && snapshot.samples.some((sample) => sample.at < snapshot.capturedAt)
      if (!startupHistory) throw new Error("Packaged snapshot did not retain pre-open startup history")
      const sourceHealth = requirePackagedSourceHealth(snapshot, process.platform)
      const server = snapshot.owners.find((owner) => owner.kind === "server")
      if (
        !server ||
        !snapshot.processes.some((process) => process.ownerId === server.id && process.role === "server")
      ) {
        throw new Error("Packaged snapshot did not separate the Claxedo server utility process")
      }
      const contributor = snapshot.interval.contributors.find(
        (item) =>
          reading(item.peakCpuMachinePercent) > 0 ||
          byteReading(item.peakRssBytes) > 0,
      )
      const contributorOwner = snapshot.owners.find((owner) => owner.id === contributor?.ownerId)
      if (!contributorOwner) throw new Error("Packaged startup did not produce a measured contributor")
      await openDiagnosticsDialog(client)
      const text = await client.evaluate<string>(
        `[...document.querySelectorAll('[role="dialog"]')]
          .find((candidate) => candidate.textContent?.includes("Local performance diagnostics"))
          ?.textContent ?? ""`,
      )
      const task = await renderedTaskEvidence(client)
      const sidecarExpected = snapshot.owners.some((owner) => owner.kind === "sidecar")
      const renderedProduct = {
        collectorState: text.includes("Collector"),
        timeline: text.includes("CPU and memory history"),
        contributorRanking: text.includes("Ranked contributors"),
        lifecycle: text.includes("Lifecycle activity"),
        sidecarExpected,
        ...task,
      }
      if (
        !renderedProduct.collectorState ||
        !renderedProduct.timeline ||
        !renderedProduct.contributorRanking ||
        !renderedProduct.lifecycle ||
        !renderedProduct.intervalIdentified ||
        !renderedProduct.electronContributor ||
        !renderedProduct.serverContributor ||
        (renderedProduct.sidecarExpected && !renderedProduct.sidecarContributor) ||
        !renderedProduct.memoryGrowthContributor ||
        !renderedProduct.limitationDisclosed ||
        !renderedProduct.churnEvidence
      ) {
        throw new Error(`Packaged diagnostics product task failed: ${JSON.stringify(renderedProduct)}`)
      }
      const actionSafety = await packagedActionSafety(client, snapshot, server.id)
      const evidence: DiagnosticsSmokeEvidence = {
        mode: "packaged",
        platform: process.platform,
        architecture: process.arch,
        startupHistory,
        topContributor: contributorOwner.label,
        serverSeparated: true,
        memoryGrowth: snapshot.interval.contributors.some(
          (item) => byteReading(item.rssChangeBytes) > 0,
        ),
        churnUnmeasured: snapshot.markers.some(
          (marker) => marker.type === "churn" && marker.resourceMeasurement.state === "unmeasured",
        ),
        redacted: true,
        actionSafety,
        retainedBytes: serialized.length,
        sourceHealth,
        renderedProduct,
      }
      if (evidence.retainedBytes > DIAGNOSTICS_RETAINED_BYTES_BUDGET) {
        throw new Error(
          `Packaged retained bytes ${String(evidence.retainedBytes)} exceeded ${String(DIAGNOSTICS_RETAINED_BYTES_BUDGET)}`,
        )
      }
      return evidence
    } finally {
      await client.evaluate(`window.api?.quit?.()`).catch(() => undefined)
      await Promise.race([application.exited, Bun.sleep(5_000)])
      client.close()
    }
  } finally {
    if (application.exitCode === null) application.kill()
    await Promise.race([application.exited, Bun.sleep(5_000)])
    await rm(userData, { recursive: true, force: true })
  }
}

async function packagedActionSafety(
  client: CdpClient,
  snapshot: LocalDiagnostics.RetainedSnapshot,
  serverOwnerId: string,
): Promise<DiagnosticsSmokeEvidence["actionSafety"]> {
  const invalidToken = "diagnostics-invalid-token-00000000"
  const first = await client.evaluate<LocalDiagnostics.ActionResult>(
    `window.api.processDiagnostics.stop(${JSON.stringify({ action: "stop", token: invalidToken })})`,
  )
  const second = await client.evaluate<LocalDiagnostics.ActionResult>(
    `window.api.processDiagnostics.stop(${JSON.stringify({ action: "stop", token: invalidToken })})`,
  )
  if (
    first.ok ||
    first.code !== "invalid-token" ||
    second.ok ||
    second.code !== "invalid-token"
  ) {
    throw new Error("Packaged diagnostics accepted an invalid opaque action token")
  }
  const serverProcesses = snapshot.processes.filter((process) => process.ownerId === serverOwnerId)
  if (
    serverProcesses.length === 0 ||
    serverProcesses.some((process) =>
      process.actionEligibility.state !== "ineligible" ||
      process.actionEligibility.reason !== "protected-process")
  ) {
    throw new Error("Packaged diagnostics exposed a destructive action for the protected Claxedo server")
  }
  if (process.platform === "darwin") {
    const fixtureProcesses = snapshot.processes.filter((process) =>
      process.ownerId === "diagnostics-packaged-stop" ||
      process.ownerId === "diagnostics-packaged-kill")
    if (
      fixtureProcesses.length < 2 ||
      fixtureProcesses.some((process) => process.actionEligibility.state === "eligible")
    ) {
      throw new Error("Packaged macOS diagnostics exposed an action without creation identity")
    }
    return "packaged-read-only"
  }
  const stop = actionGrant(snapshot, "diagnostics-packaged-stop", "stop")
  const stopped = await client.evaluate<LocalDiagnostics.ActionResult>(
    `window.api.processDiagnostics.stop(${JSON.stringify({ action: "stop", token: stop.token })})`,
  )
  if (!stopped.ok) throw new Error(`Packaged owner-scoped Stop failed: ${stopped.code}`)
  const replayed = await client.evaluate<LocalDiagnostics.ActionResult>(
    `window.api.processDiagnostics.stop(${JSON.stringify({ action: "stop", token: stop.token })})`,
  )
  if (replayed.ok || replayed.code !== "invalid-token") {
    throw new Error("Packaged owner-scoped Stop token was not single-use")
  }
  const afterStop = await client.evaluate<LocalDiagnostics.RetainedSnapshot>(
    `window.api.processDiagnostics.getSnapshot()`,
  )
  const kill = actionGrant(afterStop, "diagnostics-packaged-kill", "kill")
  const killed = await client.evaluate<LocalDiagnostics.ActionResult>(
    `window.api.processDiagnostics.kill(${JSON.stringify({ action: "kill", token: kill.token })})`,
  )
  if (!killed.ok) throw new Error(`Packaged owner-scoped Kill failed: ${killed.code}`)
  return "verified"
}

function actionGrant(
  snapshot: LocalDiagnostics.RetainedSnapshot,
  ownerId: string,
  action: LocalDiagnostics.ActionKind,
) {
  const process = snapshot.processes.find((candidate) =>
    candidate.ownerId === ownerId &&
    candidate.actionEligibility.state === "eligible" &&
    candidate.actionEligibility.actions.some((grant) => grant.action === action))
  if (!process || process.actionEligibility.state !== "eligible") {
    throw new Error(`Packaged diagnostics did not expose an identity-bound ${action} grant for ${ownerId}`)
  }
  const grant = process.actionEligibility.actions.find((candidate) => candidate.action === action)
  if (!grant) throw new Error(`Packaged diagnostics ${action} grant disappeared for ${ownerId}`)
  return grant
}

async function renderedTaskEvidence(client: CdpClient) {
  return await client.evaluate<NonNullable<DiagnosticsSmokeEvidence["renderedProduct"]>>(`(() => {
    const root = [...document.querySelectorAll('[role="dialog"]')]
      .find((candidate) => candidate.textContent?.includes("Local performance diagnostics"))
    if (!root) return {}
    const contributors = [...root.querySelectorAll('[data-testid="diagnostics-contributor"]')]
    const kinds = new Set(contributors.map((item) => item.dataset.ownerKind))
    const range = root.querySelector('[aria-label="Selected interval summary"]')
    const memoryGrowthContributor = contributors.some((item) => {
      const value = Number(item.dataset.rssChange)
      return item.dataset.ownerId === "diagnostics-packaged-stop" &&
        Number.isFinite(value) &&
        value > 0
    })
    const churnEvidence = [...root.querySelectorAll('[data-testid="diagnostics-churn"]')]
      .some((item) =>
        item.dataset.ownerId === "diagnostics-packaged-churn" &&
        item.textContent?.includes("resources unmeasured"))
    return {
      intervalIdentified:
        Number.isFinite(Number(range?.dataset.diagnosticsRangeStart)) &&
        Number.isFinite(Number(range?.dataset.diagnosticsRangeEnd)) &&
        Number(range?.dataset.diagnosticsRangeEnd) > Number(range?.dataset.diagnosticsRangeStart),
      electronContributor: ["app", "electron-main", "renderer", "gpu", "utility"].some((kind) =>
        kinds.has(kind)),
      serverContributor: kinds.has("server"),
      sidecarContributor: kinds.has("sidecar"),
      memoryGrowthContributor,
      limitationDisclosed:
        root.textContent?.includes("unmeasured churn, never as zero usage") === true &&
        root.querySelectorAll('[data-testid="diagnostics-source"]').length > 0,
      churnEvidence,
    }
  })()`)
}

export function requirePackagedSourceHealth(
  snapshot: Pick<LocalDiagnostics.RetainedSnapshot, "sources">,
  platform: NodeJS.Platform,
) {
  const required = requiredPackagedSources(platform)
  if (required.length === 0) throw new Error(`Unsupported packaged diagnostics platform: ${platform}`)
  const states = Object.fromEntries(snapshot.sources.map((source) => [source.source, source.state]))
  const unhealthy = required.filter((source) => states[source] !== "healthy")
  if (unhealthy.length > 0) {
    const details = new Map(snapshot.sources.map((source) => [
      source.source,
      "reason" in source ? `${source.state}:${source.reason}` : source.state,
    ]))
    throw new Error(
      `Packaged diagnostics sources were not healthy: ${unhealthy
        .map((source) => `${source}=${details.get(source) ?? "missing"}`)
        .join(", ")}`,
    )
  }
  return states
}

async function connectToPackagedApp(port: number, application: Bun.Subprocess) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (application.exitCode !== null) {
      throw new Error(`Packaged Claxedo exited before its renderer became reachable: ${String(application.exitCode)}`)
    }
    const targets = await fetch(`http://127.0.0.1:${String(port)}/json`, {
      signal: AbortSignal.timeout(2_000),
    }).then((response) => response.json() as Promise<Array<{
      type: string
      url: string
      webSocketDebuggerUrl: string
    }>>).catch(() => [])
    const target = targets.find((item) =>
      item.type === "page" && item.url.includes("/out/renderer/index.html"))
    if (target) return await createCdpClient(target.webSocketDebuggerUrl)
    await Bun.sleep(250)
  }
  throw new Error("Packaged Claxedo DevTools endpoint did not become reachable")
}

async function waitForMainWindow(client: CdpClient) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const ready = await client.evaluate<boolean>(
      `document.readyState === "complete" && typeof window.api?.processDiagnostics?.getSnapshot === "function"`,
    ).catch(() => false)
    if (ready) return
    await Bun.sleep(500)
  }
  throw new Error("Packaged Claxedo main window did not become ready")
}

async function openDiagnosticsDialog(client: CdpClient) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const opened = await client.evaluate<boolean>(`(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')]
        .find((candidate) => candidate.textContent?.includes("Local performance diagnostics"))
      if (dialog) return true
      const emptyTrigger = document.querySelector('[data-testid="empty-diagnostics-trigger"]')
      if (emptyTrigger instanceof HTMLElement) {
        emptyTrigger.click()
        return true
      }
      const trigger = document.querySelector('[data-testid="rail-account-trigger"]')
      if (!trigger) return false
      trigger.click()
      const item = [...document.querySelectorAll('[role="menuitem"]')]
        .find((candidate) => candidate.textContent?.trim() === "Diagnostics")
      if (!item) return false
      item.click()
      return true
    })()`).catch(() => false)
    if (opened) {
      const ready = await client.evaluate<boolean>(
        `[...document.querySelectorAll('[role="dialog"]')]
          .some((candidate) =>
            candidate.textContent?.includes("Local performance diagnostics") &&
            candidate.textContent.includes("Ranked contributors"))`,
      ).catch(() => false)
      if (ready) return
    }
    await Bun.sleep(250)
  }
  const screen = await client.evaluate<string>(
    `document.body?.innerText?.replace(/\\s+/g, " ").slice(0, 500) ?? "<empty>"`,
  ).catch(() => "<unavailable>")
  throw new Error(`Packaged Diagnostics dialog did not become reachable from fresh state: ${screen}`)
}

async function availablePort() {
  const server = createServer()
  const port = await new Promise<number>((resolvePort, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Could not reserve a diagnostics smoke debug port"))
        return
      }
      resolvePort(address.port)
    })
  })
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => error ? reject(error) : resolveClose()))
  return port
}

async function waitForSnapshot(client: CdpClient) {
  const deadline = Date.now() + 60_000
  let last: LocalDiagnostics.RetainedSnapshot | undefined
  while (Date.now() < deadline) {
    const snapshot = await client.evaluate<LocalDiagnostics.RetainedSnapshot | undefined>(
      `window.api?.processDiagnostics?.getSnapshot?.()`,
    ).catch(() => undefined)
    last = snapshot ?? last
    if (
      snapshot &&
      snapshot.samples.length > 1 &&
      snapshot.owners.some((owner) => owner.kind === "server") &&
      snapshot.processes.some((process) => process.ownerId === "diagnostics-packaged-stop") &&
      snapshot.processes.some((process) => process.ownerId === "diagnostics-packaged-kill") &&
      snapshot.interval.contributors.some((contributor) =>
        contributor.ownerId === "diagnostics-packaged-stop" &&
        byteReading(contributor.rssChangeBytes) > 0) &&
      snapshot.markers.some((marker) =>
        marker.type === "churn" &&
        marker.ownerId === "diagnostics-packaged-churn" &&
        marker.resourceMeasurement.state === "unmeasured") &&
      packagedSourcesReady(snapshot, process.platform)
    ) return snapshot
    await Bun.sleep(500)
  }
  throw new Error(
    `Packaged diagnostics snapshot did not become ready: ${JSON.stringify({
      samples: last?.samples.length ?? 0,
      owners: last?.owners.map((owner) => owner.kind) ?? [],
      sources: last?.sources.map((source) => ({
        source: source.source,
        state: source.state,
        ...("reason" in source ? { reason: source.reason } : {}),
      })) ?? [],
    })}`,
  )
}

function packagedSourcesReady(
  snapshot: Pick<LocalDiagnostics.RetainedSnapshot, "sources">,
  platform: NodeJS.Platform,
) {
  const required = requiredPackagedSources(platform)
  const states = new Map(snapshot.sources.map((source) => [source.source, source.state]))
  return required.length > 0 && required.every((source) => states.get(source) === "healthy")
}

function requiredPackagedSources(platform: NodeJS.Platform) {
  if (platform === "darwin") return ["electron", "macos-ps"]
  if (platform === "linux") return ["electron", "linux-proc"]
  if (platform === "win32") return ["electron", "windows-cim", "windows-process-tree"]
  return []
}

type CdpClient = {
  evaluate<T = unknown>(expression: string): Promise<T>
  close(): void
}

async function createCdpClient(url: string): Promise<CdpClient> {
  const socket = new WebSocket(url)
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  let sequence = 0
  await new Promise<void>((resolveOpen, reject) => {
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error("Timed out connecting to packaged renderer CDP"))
    }, 15_000)
    socket.addEventListener("open", () => {
      clearTimeout(timer)
      resolveOpen()
    }, { once: true })
    socket.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error("Could not connect to packaged renderer CDP"))
    }, { once: true })
  })
  const rejectPending = (error: Error) => {
    pending.forEach((request) => {
      clearTimeout(request.timer)
      request.reject(error)
    })
    pending.clear()
  }
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number
      result?: unknown
      error?: { message?: string }
    }
    if (message.id === undefined) return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) {
      request.reject(new Error(message.error.message ?? "CDP command failed"))
      return
    }
    request.resolve(message.result)
  })
  const command = <T>(method: string, params: Record<string, unknown> = {}) =>
    new Promise<T>((resolveCommand, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Packaged renderer CDP command timed out: ${method}`))
      }, 15_000)
      pending.set(id, { resolve: resolveCommand as (value: unknown) => void, reject, timer })
      try {
        socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  socket.addEventListener("close", () => rejectPending(new Error("Packaged renderer CDP closed")))
  socket.addEventListener("error", () => rejectPending(new Error("Packaged renderer CDP failed")))
  await command("Runtime.enable")
  return {
    async evaluate<T>(expression: string) {
      const output = await command<{
        result: { value?: T; description?: string }
        exceptionDetails?: { text?: string; exception?: { description?: string } }
      }>("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      })
      if (output.exceptionDetails) {
        throw new Error(
          output.exceptionDetails.exception?.description ??
          output.exceptionDetails.text ??
          "Packaged renderer evaluation failed",
        )
      }
      return output.result.value as T
    },
    close() {
      rejectPending(new Error("Packaged renderer CDP closed"))
      socket.close()
    },
  }
}

async function discoverPackagedExecutable() {
  const dist = resolve(import.meta.dirname, "../dist")
  const productName = process.env.CLAXEDO_CHANNEL === "prod" ? "Claxedo" : "Claxedo Dev"
  const output = process.arch === "arm64" ? "-arm64" : ""
  const candidates =
    process.platform === "darwin"
      ? [join(dist, `mac${output}`, `${productName}.app`, "Contents", "MacOS", productName)]
      : process.platform === "win32"
        ? [join(dist, `win${output}-unpacked`, `${productName}.exe`)]
        : // Single candidate by contract: electron-builder.config.ts pins
          // linux executableName to "claxedo" for every channel.
          [join(dist, `linux${output}-unpacked`, "claxedo")]
  for (const file of candidates) {
    if (await Bun.file(file).exists()) return file
  }
  throw new Error(`No native packaged Claxedo executable found: ${candidates.join(", ")}`)
}

function emptyElectronSource(): ElectronDiagnosticsSource {
  return {
    id: "electron",
    domain: "host",
    accuracy: "native",
    capabilities: {
      cpu: true,
      rss: true,
      ancestry: true,
      creationIdentity: true,
      actionIdentity: false,
    },
    collect: () => [],
    registerRoot: () => () => undefined,
  }
}

function reading(value: LocalDiagnostics.CpuMachinePercent) {
  return value.state === "available" ? value.value : 0
}

function byteReading(value: LocalDiagnostics.ByteReading) {
  return value.state === "available" ? value.value : 0
}

async function measureDiagnosticsTreeCpu(enabled: boolean) {
  // EMFILE forensics: this spawn has died with "too many open files" on CI
  // runners even after the /proc scan was reduced to a children walk. Print
  // the live fd count so the next failure shows whether THIS process is
  // leaking (count near the soft limit) or the errno is coming from the
  // system table.
  if (process.platform === "linux") {
    const fdCount = await readdir("/proc/self/fd").then((entries) => entries.length).catch(() => -1)
    console.log(`[diagnostics-smoke] open fds before probe spawn: ${String(fdCount)}`)
  }
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      import.meta.path,
      enabled ? "--cpu-probe-enabled" : "--cpu-probe-control",
    ],
    cwd: tmpdir(),
    env: {
      PATH: process.env.PATH ?? "",
      CLAXEDO_DIAGNOSTICS_WORKER_PATH: resolve(
        import.meta.dirname,
        "../out/main/process-metrics-worker.js",
      ),
    },
    stdout: "pipe",
    stderr: "inherit",
  })
  if (!child.pid) throw new Error("Could not start diagnostics CPU probe")
  try {
    const reader = child.stdout.getReader()
    const ready = await Promise.race([
      reader.read(),
      Bun.sleep(10_000).then(() => {
        throw new Error("Diagnostics CPU probe did not become ready")
      }),
    ])
    reader.releaseLock()
    if (ready.done || !new TextDecoder().decode(ready.value).includes("READY")) {
      throw new Error("Diagnostics CPU probe exited before measurement")
    }
    // pidtree shells out to `ps`; under bun on loaded Linux runners that spawn
    // repeatedly comes back without stdio (child.stdout undefined) and throws
    // even across retries. On Linux, skip the subprocess entirely and walk
    // /proc for the descendant set — same tree, no spawn to fail.
    const procTree = async (root: number) => {
      // Descend via /proc/<pid>/task/*/children instead of scanning ALL of
      // /proc for ppids: a busy runner has thousands of pids and even a
      // sequential stat-file sweep exhausted the process fd table (EMFILE on
      // the next Bun.spawn / on /proc/uptime). The children walk opens files
      // proportional to the probe's own tree, which is a dozen entries.
      const tree = new Set<number>([root])
      const queue = [root]
      while (queue.length > 0) {
        const pid = queue.shift()
        if (pid === undefined) break
        const tasks = await readdir(`/proc/${String(pid)}/task`).catch(() => [] as string[])
        for (const tid of tasks) {
          const children = await readFile(`/proc/${String(pid)}/task/${tid}/children`, "utf8").catch(() => "")
          for (const token of children.trim().split(/\s+/)) {
            const child = Number(token)
            if (Number.isFinite(child) && child > 0 && !tree.has(child)) {
              tree.add(child)
              queue.push(child)
            }
          }
        }
      }
      return [...tree]
    }
    // Callback form inside our own promise, never pidtree's promise API: its
    // Windows PowerShell path can fire the callback with "No matching pid
    // found" OUTSIDE the promise chain (a late second invocation), which
    // surfaces as an UNCAUGHT error a try/catch around the await never sees —
    // it killed the release smoke with the probe demonstrably alive. Here a
    // duplicate callback is a no-op resolve, and an error resolves undefined.
    const pidtreeOnce = (pid: number) =>
      new Promise<number[] | undefined>((resolvePids) => {
        pidtree(pid, { root: true }, (error, pids) => resolvePids(error ? undefined : pids))
      })
    const sampleTree = async () => {
      if (process.platform === "linux") return procTree(child.pid)
      for (let attempt = 0; attempt < 3; attempt++) {
        const pids = await pidtreeOnce(child.pid)
        if (pids) return pids
        await Bun.sleep(250)
      }
      // The sweep raced process churn on every retry. A dead probe is a real
      // failure; a live one degrades to measuring just the root pid.
      if (child.exitCode === null) return [child.pid]
      throw new Error("Diagnostics CPU probe exited while sampling its process tree")
    }
    // Linux NEVER goes through pidusage: its procfile path is broken for
    // `maxage: 0` — history.set early-returns when maxage <= 0, so the cached
    // entry is always missing, the `again` retry recurses forever, and every
    // iteration opens a fresh /proc/<pid>/stat fd until the process hits
    // EMFILE (observed: 65535 open fds, then the next Bun.spawn dies). Sum
    // utime+stime ticks from /proc directly instead; readFile closes its fd.
    const linuxCpuTicks = async (pids: number[]) => {
      let ticks = 0
      for (const pid of pids) {
        const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8").catch(() => "")
        const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
        const utime = Number(tail[11])
        const stime = Number(tail[12])
        if (Number.isFinite(utime)) ticks += utime
        if (Number.isFinite(stime)) ticks += stime
      }
      return ticks
    }
    if (process.platform === "linux") {
      const LINUX_CLOCK_TICKS_PER_SECOND = 100 // CLK_TCK on every mainstream distro/kernel config
      const initial = await sampleTree()
      const startTicks = await linuxCpuTicks(initial)
      const startedAt = performance.now()
      await Bun.sleep(5_000)
      const measured = await sampleTree()
      const endTicks = await linuxCpuTicks(measured)
      const elapsedSeconds = Math.max(0.001, (performance.now() - startedAt) / 1_000)
      const corePercent = (Math.max(0, endTicks - startTicks) / LINUX_CLOCK_TICKS_PER_SECOND / elapsedSeconds) * 100
      return Math.min(100, corePercent / Math.max(1, cpus().length))
    }
    // pidusage throws "No matching pid found" when ANY pid in the batch exits
    // between our tree sample and its own /proc read — routine for a probe
    // tree that spawns short-lived children. Query per-pid and drop the dead.
    const usageFor = async (pids: number[]) => {
      const result: Record<number, { cpu: number }> = {}
      for (const pid of pids) {
        const stats = await packageUsage(pid, {
          maxage: 0,
          ...(process.platform === "darwin" ? { usePs: true } : {}),
        }).catch(() => undefined)
        if (stats) result[pid] = stats as { cpu: number }
      }
      return result
    }
    const initial = await sampleTree()
    await usageFor(initial)
    await Bun.sleep(5_000)
    const measured = await sampleTree()
    const usage = await usageFor(measured)
    return Math.min(
      100,
      measured.reduce((total, pid) => total + Math.max(0, usage[pid]?.cpu ?? 0), 0) /
        Math.max(1, cpus().length),
    )
  } finally {
    if (child.exitCode === null) child.kill()
    await Promise.race([child.exited, Bun.sleep(2_000)])
    packageUsage.clear()
  }
}

async function runCpuProbe(enabled: boolean) {
  const fixture = Bun.spawn({
    cmd: [process.execPath, "-e", "setInterval(()=>{},1000)"],
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? "" },
    stdout: "ignore",
    stderr: "ignore",
  })
  if (!fixture.pid) throw new Error("Could not start diagnostics CPU probe fixture")
  const source = enabled
    ? createProcessMetricsSource({
        platform: process.platform,
        electron: emptyElectronSource(),
        workerPath: process.env.CLAXEDO_DIAGNOSTICS_WORKER_PATH,
      })
    : undefined
  const profiler = source
    ? createProfiler({ source, startupDurationMs: 0, steadyIntervalMs: 2_000 })
    : undefined
  if (profiler) {
    profiler.recordOwnerEvent({
      type: "owner-registered",
      at: Date.now(),
      binding: { pid: process.pid, launchId: "cpu-probe", generation: "cpu-probe" },
      descriptor: {
        ownerId: "diagnostics-cpu-probe",
        ownerGeneration: crypto.randomUUID(),
        ownerOperationId: crypto.randomUUID(),
        launchId: crypto.randomUUID(),
        kind: "harness",
        role: "harness",
        label: "Diagnostics CPU probe",
        pid: fixture.pid,
        capabilities: { stopGracefully: false, killOwnedTree: false },
      },
    })
  }
  console.log("READY")
  // Long lifetime, parent-terminated: the measuring parent kills this probe in
  // its finally as soon as sampling ends, so the sleep is a backstop, not the
  // duration. 8s was too tight for Windows — three cold-start PowerShell
  // pidtree sweeps exceeded it, the probe exited ON SCHEDULE mid-sampling,
  // and the parent misread that as a probe crash.
  await Bun.sleep(60_000)
  profiler?.dispose()
  fixture.kill()
  await Promise.race([fixture.exited, Bun.sleep(2_000)])
}

async function runFlowProfiler() {
  const rootPids = (process.env.CLAXEDO_DIAGNOSTICS_FLOW_ROOT_PIDS ?? "")
    .split(",")
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff)
  const output = process.env.CLAXEDO_DIAGNOSTICS_FLOW_OUTPUT
  if (rootPids.length === 0 || !output) {
    throw new Error("Diagnostics flow profiler requires bounded root PIDs and output")
  }
  const source =
    process.env.CLAXEDO_DIAGNOSTICS_FLOW_SOURCE === "cdp"
      ? createCdpFlowSource(rootPids)
      : createProcessMetricsSource({
          platform: process.platform,
          electron: emptyElectronSource(),
          workerPath: process.env.CLAXEDO_DIAGNOSTICS_WORKER_PATH,
        })
  const profiler = createProfiler({
    source,
    ...(process.env.CLAXEDO_DIAGNOSTICS_FLOW_INTERACTIVE === "1" ? { startupDurationMs: 0 } : {}),
  })
  rootPids.forEach((pid) => {
    profiler.recordOwnerEvent({
      type: "owner-registered",
      at: Date.now(),
      binding: { pid: process.pid, launchId: "flow-profiler", generation: "flow-profiler" },
      descriptor: {
        ownerId: `diagnostics-flow-root-${String(pid)}`,
        ownerGeneration: crypto.randomUUID(),
        ownerOperationId: crypto.randomUUID(),
        launchId: crypto.randomUUID(),
        kind: "harness",
        role: "harness",
        label: "Real app performance flow",
        pid,
        capabilities: { stopGracefully: false, killOwnedTree: false },
      },
    })
  })
  console.log("READY")
  await Promise.race([
    new Promise<void>((resolve) => process.stdin.once("end", resolve)),
    Bun.sleep(180_000).then(() => {
      throw new Error("Diagnostics flow profiler stop signal timed out")
    }),
  ])
  profiler.requestSample("manual")
  await Bun.sleep(2_250)
  const stats = profiler.getStats()
  const snapshot = profiler.getSnapshot()
  await Bun.write(output, `${JSON.stringify({
    retainedBytes: stats.retainedBytes,
    retainedProcesses: stats.retainedProcesses,
    droppedTicks: stats.droppedTicks,
    maxSourceDurationMs: stats.maxSourceDurationMs,
    maxReconciliationDurationMs: stats.maxReconciliationDurationMs ?? 0,
    collections: stats.collections,
    sampleCount: snapshot.samples.length,
  })}\n`)
  profiler.dispose()
}

function createCdpFlowSource(rootPids: number[]): DiagnosticsSource {
  type Entry = { id: number; type: string; cpuTime: number }
  let latest: { at: number; processes: Entry[] } | undefined
  const previous = new Map<number, { at: number; cpuTime: number }>()
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on("line", (line) => {
    try {
      const input = JSON.parse(line) as { at?: unknown; processes?: unknown }
      if (typeof input.at !== "number" || !Array.isArray(input.processes)) return
      latest = {
        at: input.at,
        processes: input.processes.flatMap((value) => {
          if (!value || typeof value !== "object") return []
          const entry = value as Record<string, unknown>
          if (
            typeof entry.id !== "number" ||
            !Number.isInteger(entry.id) ||
            entry.id <= 0 ||
            typeof entry.type !== "string" ||
            typeof entry.cpuTime !== "number" ||
            !Number.isFinite(entry.cpuTime) ||
            entry.cpuTime < 0
          ) return []
          return [{ id: entry.id, type: entry.type.slice(0, 64), cpuTime: entry.cpuTime }]
        }),
      }
    } catch {
      // A malformed test feed remains unavailable; it never enters retained diagnostics.
    }
  })
  const ownerId = `diagnostics-flow-root-${String(rootPids[0]!)}`
  const logicalProcessors = Math.max(1, cpus().length)
  return {
    id: "electron",
    domain: "host",
    accuracy: "native",
    capabilities: {
      cpu: true,
      rss: false,
      ancestry: false,
      creationIdentity: false,
      actionIdentity: false,
    },
    collect(at) {
      if (!latest) return []
      return latest.processes.map((entry) => {
        const prior = previous.get(entry.id)
        previous.set(entry.id, { at: latest!.at, cpuTime: entry.cpuTime })
        const elapsedSeconds = prior ? (latest!.at - prior.at) / 1_000 : 0
        const cpuMachinePercent =
          prior && elapsedSeconds > 0 && entry.cpuTime >= prior.cpuTime
            ? {
                state: "available" as const,
                value: Math.min(
                  100,
                  Math.max(0, ((entry.cpuTime - prior.cpuTime) / elapsedSeconds / logicalProcessors) * 100),
                ),
              }
            : { state: "unavailable" as const, reason: "warming-up" as const }
        const identity = {
          id: `cdp-${String(entry.id)}`,
          domain: "host" as const,
          pid: entry.id,
          creation: { state: "unavailable" as const, reason: "identity-unavailable" as const },
          launchId: `cdp-${String(entry.id)}`,
        }
        return {
          owner: {
            id: ownerId,
            kind: "app" as const,
            label: "Real app performance flow",
            access: "local" as const,
            lifecycle: "current" as const,
          },
          process: {
            identity,
            ownerId,
            role: cdpProcessRole(entry.type),
            label: `Chromium ${entry.type}`.slice(0, 256),
            lifecycle: "running" as const,
            actionEligibility: {
              state: "ineligible" as const,
              reason: "owner-operation-unavailable" as const,
            },
          },
          point: {
            at,
            processId: identity.id,
            cpuMachinePercent,
            rssBytes: { state: "unavailable" as const, reason: "unsupported" as const },
          },
        }
      })
    },
    dispose() {
      lines.close()
      previous.clear()
    },
  }
}

function cdpProcessRole(type: string): LocalDiagnostics.ProcessRole {
  const normalized = type.toLowerCase()
  if (normalized === "browser") return "main"
  if (normalized.includes("renderer")) return "renderer"
  if (normalized.includes("gpu")) return "gpu"
  return "utility"
}

function assertExpectedArchitecture() {
  const expected = process.env.CLAXEDO_DIAGNOSTICS_EXPECTED_ARCH
  if (expected && process.arch !== expected) {
    throw new Error(`Diagnostics smoke expected ${expected}, running on ${process.arch}`)
  }
}

if (import.meta.main) {
  if (process.argv.includes("--flow-profiler")) {
    await runFlowProfiler()
    process.exit(0)
  }
  const cpuProbe = process.argv.includes("--cpu-probe-enabled")
    ? true
    : process.argv.includes("--cpu-probe-control")
      ? false
      : undefined
  if (cpuProbe !== undefined) {
    await runCpuProbe(cpuProbe)
    process.exit(0)
  }
  const evidence = process.argv.includes("--packaged") ? await runPackagedSmoke() : await runSourceSmoke()
  const output = process.env.CLAXEDO_DIAGNOSTICS_SMOKE_OUTPUT
  if (output) await Bun.write(output, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(`[diagnostics-smoke] ${JSON.stringify(evidence, null, 2)}`)
}
