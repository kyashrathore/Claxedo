#!/usr/bin/env bun

import { createRequire } from "node:module"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { MAIN_RENDERER_DOCUMENT } from "../src/main/navigation-guard"
import {
  IdleProcessFamilyTracker,
  parseIdleProcessTable,
  summarizeIdleResourceWindow,
  type IdleProcessFamilyObservation,
  type IdleProcessRow,
} from "../../claxedo-app/perf-harness/src/idle-process-family"

type JsonObject = Record<string, unknown>
type Target = { type: string; url: string; webSocketDebuggerUrl?: string }

const packageDir = path.resolve(import.meta.dir, "..")
const mainPath = path.join(packageDir, "out/main/index.js")
const cdpPort = Number(Bun.env.CLAXEDO_DESKTOP_CDP_PORT ?? "9460")
const serverPort = Number(Bun.env.CLAXEDO_SERVER_PORT ?? String(cdpPort + 1_000))
const settleMs = positiveDuration("CLAXEDO_MEMORY_SETTLE_MS", 15_000)
const sampleDurationMs = positiveDuration("CLAXEDO_MEMORY_SAMPLE_DURATION_MS", 60_000)
const sampleIntervalMs = positiveDuration("CLAXEDO_MEMORY_SAMPLE_INTERVAL_MS", 1_000)
const shutdownGraceMs = positiveDuration("CLAXEDO_MEMORY_SHUTDOWN_GRACE_MS", 5_000)
const terminalCount = positiveInteger("CLAXEDO_MEMORY_TERMINAL_COUNT", 3)
const fixturePath = Bun.env.CLAXEDO_MEMORY_FIXTURE
  ? path.resolve(packageDir, Bun.env.CLAXEDO_MEMORY_FIXTURE)
  : path.join(import.meta.dir, "fixtures/memory-profile/state.json")
const fixtureTemplate = await Bun.file(fixturePath).json()

const packagedExecutable = Bun.env.CLAXEDO_MEMORY_EXECUTABLE?.trim()
if (!packagedExecutable && (Bun.env.CLAXEDO_MEMORY_REBUILD === "1" || !(await Bun.file(mainPath).exists()))) {
  const build = Bun.spawnSync(["bun", "run", "build:inner"], {
    cwd: packageDir,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!build.success) throw new Error(`desktop build failed:\n${build.stderr.toString()}\n${build.stdout.toString()}`)
}
if (!packagedExecutable && !(await Bun.file(mainPath).exists())) {
  throw new Error(`desktop main bundle is missing: ${mainPath}`)
}
if (packagedExecutable && !(await Bun.file(packagedExecutable).exists())) {
  throw new Error(`packaged desktop executable is missing: ${packagedExecutable}`)
}

const root = await mkdtemp(path.join(tmpdir(), "claxedo-memory-"))
const userDataDir = path.join(root, "chromium")
const dataDir = path.join(root, "data")
const memoryWorkspaceDir = path.join(root, "workspace")
await Promise.all([mkdir(userDataDir), mkdir(dataDir), mkdir(memoryWorkspaceDir)])
const initializeWorkspace = Bun.spawnSync(["git", "init", "--quiet", memoryWorkspaceDir], {
  stdout: "pipe",
  stderr: "pipe",
})
if (!initializeWorkspace.success) {
  throw new Error(`memory workspace git init failed: ${initializeWorkspace.stderr.toString()}`)
}

const launchCommand = packagedExecutable
  ? [packagedExecutable, `--remote-debugging-port=${String(cdpPort)}`]
  : [String(createRequire(import.meta.url)("electron")), `--remote-debugging-port=${String(cdpPort)}`, mainPath]
const app = Bun.spawn(launchCommand, {
  cwd: packageDir,
  env: {
    ...Bun.env,
    CLAXEDO_DATA_DIR: dataDir,
    CLAXEDO_DESKTOP_USER_DATA_DIR: userDataDir,
    CLAXEDO_SERVER_PORT: String(serverPort),
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
  },
  stdout: "pipe",
  stderr: "pipe",
})
const stdout = new Response(app.stdout).text()
const stderr = new Response(app.stderr).text()
if (!app.pid) throw new Error("desktop process did not expose a root PID")
const familyTracker = new IdleProcessFamilyTracker(app.pid)
familyTracker.survivors(readProcessTable())

let client: Awaited<ReturnType<typeof connect>> | undefined
let failure: unknown
let report: JsonObject | undefined
let survivorRows: IdleProcessRow[] = []

const warmupStartedAt = Date.now()
try {
  client = await connect(await waitForTarget())
  await client.send("Runtime.enable")
  await client.send("Page.enable")
  await waitForExpression(client, "document.readyState === 'complete'")
  const fixture = await prepareMemoryFixture(serverPort, fixtureTemplate)
  await client.send("Runtime.evaluate", {
    expression: `localStorage.setItem("claxedo.state.v5", ${JSON.stringify(JSON.stringify(fixture))})`,
  })
  await client.send("Page.reload", { ignoreCache: true })
  await waitForExpression(
    client,
    `document.readyState === "complete" && Boolean(document.querySelector('[data-workbench-content="memory-session-1"] [data-testid="session-content"] [data-component="prompt-input"]'))`,
  )
  const core = await warmCore(serverPort, terminalCount)

  await client.send("Performance.enable")
  await client.send("HeapProfiler.enable")
  await client.send("HeapProfiler.collectGarbage")
  const warmupEndedAt = Date.now()
  const settleStartedAt = warmupEndedAt
  await delay(settleMs)
  const settleEndedAt = Date.now()
  await requireRetainedTerminals(serverPort, core.terminalIds)

  const sampled = await sampleIdleWindow(familyTracker, sampleDurationMs, sampleIntervalMs)
  await requireRetainedTerminals(serverPort, core.terminalIds)
  if (!sampled.summary.valid) {
    throw new Error(`invalid idle resource window: ${sampled.summary.invalidReasons.join(", ")}`)
  }

  const performanceMetrics = asObject(await client.send("Performance.getMetrics")).metrics
  const metric = (name: string) => {
    if (!Array.isArray(performanceMetrics)) return 0
    const item = performanceMetrics.find((entry) => asObject(entry).name === name)
    return Number(asObject(item).value ?? 0)
  }
  const page = asObject(evaluationValue(await client.send("Runtime.evaluate", {
    expression: `(() => ({
      restoredContentCount: (() => {
        try {
          const state = JSON.parse(localStorage.getItem("claxedo.state.v5") ?? "{}")
          return Array.isArray(state?.workbench?.contentIds) ? state.workbench.contentIds.length : 0
        } catch {
          return 0
        }
      })(),
      mountedContentCount: document.querySelectorAll("[data-workbench-content]").length,
      activeSurfaceReady: Number(Boolean(document.querySelector('[data-workbench-content="memory-session-1"] [data-testid="session-content"] [data-component="prompt-input"]'))),
      rendererReady: Number(document.readyState === "complete" && Boolean(document.getElementById("root")?.children.length)),
    }))()`,
    returnByValue: true,
  })))
  if (Number(page.activeSurfaceReady ?? 0) !== 1) {
    throw new Error("memory profile active session surface was not ready after the sampling window")
  }

  const processes = currentTrackedFamily(familyTracker)
  const roles = {
    main: processes.find((process) => process.pid === app.pid),
    gpu: processes.find((process) => process.command.includes("--type=gpu-process")),
    renderer: processes.find((process) => process.command.includes("--type=renderer")),
    server: processes.find(
      (process) =>
        process.command.includes("--utility-sub-type=node.mojom.NodeService") ||
        process.command.includes("claxedo-server/index.js"),
    ),
    metrics: processes.find((process) => process.command.includes("process-metrics-worker.js")),
  }
  const footprint = nativeFootprint(processes)
  const rssMiB = (process?: IdleProcessRow) => round((process?.rssBytes ?? 0) / 1024 / 1024)
  const resourceSamples = sampled.observations.map((sample, index) => ({
    at_ms: sample.atMs - sampled.startedAt,
    rss_mib: round(sample.rssBytes / 1024 / 1024),
    ...(sample.cpuPercent === undefined ? {} : { cpu_percent: round(sample.cpuPercent) }),
    process_count: sample.processCount,
    ...(sample.discoveredPids.length === 0 ? {} : { discovered_pids: sample.discoveredPids }),
    ...(sample.disappearedPids.length === 0 ? {} : { disappeared_pids: sample.disappearedPids }),
    sample_index: index,
  }))

  report = {
    profile: path.basename(path.dirname(fixturePath)),
    launch_mode: packagedExecutable ? "packaged" : "production-bundle",
    root_pid: app.pid,
    measurement_valid: 1,
    total_rss_mib: round(sampled.summary.finalRssBytes / 1024 / 1024),
    peak_process_family_rss_mib: round(sampled.summary.peakRssBytes / 1024 / 1024),
    "resource.peak_process_family_rss_mib": round(sampled.summary.peakRssBytes / 1024 / 1024),
    quiescent_rss_p95_mib: round(sampled.summary.rssP95Bytes / 1024 / 1024),
    quiescent_cpu_p95_pct: round(sampled.summary.cpuP95Percent),
    "resource.quiescent_cpu_p95_pct": round(sampled.summary.cpuP95Percent),
    renderer_ready: Number(page.rendererReady ?? 0),
    core_routes_ok: core.routes,
    terminal_smoke_ok: core.terminal,
    retained_terminal_count: core.terminalIds.length,
    health_status: core.status.health,
    project_status: core.status.project,
    session_status: core.status.sessions,
    config_status: core.status.config,
    providers_status: core.status.providers,
    terminal_create_statuses: core.status.terminalCreate,
    terminal_list_status: core.status.terminalList,
    restored_content_count: Number(page.restoredContentCount ?? 0),
    mounted_content_count: Number(page.mountedContentCount ?? 0),
    active_surface_ready: Number(page.activeSurfaceReady ?? 0),
    total_footprint_mib: footprint.summary,
    main_rss_mib: rssMiB(roles.main),
    gpu_rss_mib: rssMiB(roles.gpu),
    renderer_rss_mib: rssMiB(roles.renderer),
    server_rss_mib: rssMiB(roles.server),
    metrics_worker_rss_mib: rssMiB(roles.metrics),
    main_footprint_mib: footprint.byPid.get(roles.main?.pid ?? -1) ?? 0,
    gpu_footprint_mib: footprint.byPid.get(roles.gpu?.pid ?? -1) ?? 0,
    renderer_footprint_mib: footprint.byPid.get(roles.renderer?.pid ?? -1) ?? 0,
    server_footprint_mib: footprint.byPid.get(roles.server?.pid ?? -1) ?? 0,
    js_heap_used_mib: round(metric("JSHeapUsedSize") / 1024 / 1024),
    documents: metric("Documents"),
    nodes: metric("Nodes"),
    layout_objects: metric("LayoutObjects"),
    iosurface_mib: footprint.iosurface,
    process_count: processes.length,
    windows: {
      warmup: {
        started_at: new Date(warmupStartedAt).toISOString(),
        ended_at: new Date(warmupEndedAt).toISOString(),
        duration_ms: warmupEndedAt - warmupStartedAt,
      },
      settle: {
        started_at: new Date(settleStartedAt).toISOString(),
        ended_at: new Date(settleEndedAt).toISOString(),
        requested_duration_ms: settleMs,
        actual_duration_ms: settleEndedAt - settleStartedAt,
      },
      quiescent_sampling: {
        started_at: new Date(sampled.startedAt).toISOString(),
        ended_at: new Date(sampled.endedAt).toISOString(),
        requested_duration_ms: sampleDurationMs,
        actual_duration_ms: sampled.endedAt - sampled.startedAt,
        requested_interval_ms: sampleIntervalMs,
        expected_cpu_samples: sampled.summary.expectedCpuSamples,
        achieved_cpu_samples: sampled.summary.achievedCpuSamples,
        max_sample_gap_ms: sampled.summary.maxSampleGapMs,
        samples: resourceSamples,
      },
    },
    process_breakdown: processes.map((process) => ({
      pid: process.pid,
      role: processRole(process, app.pid),
      rss_mib: rssMiB(process),
      footprint_mib: footprint.byPid.get(process.pid) ?? 0,
    })),
  }
} catch (error) {
  failure = error
} finally {
  client?.close()
  try {
    survivorRows = await shutdownProcessFamily(app, familyTracker, shutdownGraceMs)
    if (survivorRows.length > 0 && !failure) {
      failure = new Error(`desktop left ${String(survivorRows.length)} surviving family process(es)`)
    }
  } catch (shutdownError) {
    if (!failure) failure = shutdownError
  }
  if (failure) {
    const [out, err] = await Promise.all([
      Promise.race([stdout, delay(1_000).then(() => "<stdout still open after cleanup>")]),
      Promise.race([stderr, delay(1_000).then(() => "<stderr still open after cleanup>")]),
    ])
    if (out.trim()) console.error(out.trim())
    if (err.trim()) console.error(err.trim())
  }
  await rm(root, { recursive: true, force: true })
}

if (report) {
  report.survivor_count = survivorRows.length
  report.survivors = survivorRows.map((process) => ({ pid: process.pid, ppid: process.ppid, command: process.command }))
  if (failure) {
    report.measurement_valid = 0
    report.failure = failure instanceof Error ? failure.message : String(failure)
  }
  console.log(JSON.stringify(report))
}
if (failure) throw failure

async function warmCore(port: number, requestedTerminalCount: number) {
  const base = `http://127.0.0.1:${String(port)}`
  const directory = encodeURIComponent(memoryWorkspaceDir)
  const health = await fetch(`${base}/api/claxedo/health`)
  const project = await fetch(`${base}/project/current?directory=${directory}`)
  const sessions = await fetch(`${base}/session?directory=${directory}&roots=true`)
  const sessionRows = sessions.ok ? await sessions.json() : undefined
  const config = await fetch(`${base}/global/config`)
  const providers = await fetch(`${base}/provider?view=index`)
  const terminalIds: string[] = []
  const terminalCreate: number[] = []
  for (let index = 0; index < requestedTerminalCount; index++) {
    const createTerminal = await fetch(`${base}/api/wr/pty?directory=${directory}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: `memory-warm-${String(index + 1)}`,
        initialCommand: retainedTerminalCommand(index),
      }),
    })
    terminalCreate.push(createTerminal.status)
    const terminal = createTerminal.ok ? asObject(await createTerminal.json()) : {}
    if (typeof terminal.id === "string") terminalIds.push(terminal.id)
  }
  const terminalList = await requireRetainedTerminals(port, terminalIds)
  const routes = Number(
    health.ok &&
      project.ok &&
      sessions.ok &&
      Array.isArray(sessionRows) &&
      config.ok &&
      providers.ok,
  )
  const terminal = Number(
    terminalIds.length === requestedTerminalCount &&
      terminalCreate.every((status) => status >= 200 && status < 300) &&
      terminalList.ok,
  )
  if (routes !== 1) throw new Error("one or more warmed core-route gates failed")
  if (terminal !== 1) throw new Error("one or more retained-terminal warm-up gates failed")
  return {
    routes,
    terminal,
    terminalIds,
    status: {
      health: health.status,
      project: project.status,
      sessions: sessions.status,
      config: config.status,
      providers: providers.status,
      terminalCreate,
      terminalList: terminalList.status,
    },
  }
}

async function requireRetainedTerminals(port: number, terminalIds: string[]) {
  const directory = encodeURIComponent(memoryWorkspaceDir)
  const response = await fetch(`http://127.0.0.1:${String(port)}/api/wr/pty?directory=${directory}`)
  const rows = response.ok ? await response.json().catch(() => undefined) : undefined
  const listed = Array.isArray(rows)
    ? new Set(rows.flatMap((entry) => typeof asObject(entry).id === "string" ? [String(asObject(entry).id)] : []))
    : new Set<string>()
  const missing = terminalIds.filter((id) => !listed.has(id))
  if (!response.ok || missing.length > 0) {
    throw new Error(
      `retained terminal gate failed (${String(response.status)}); missing IDs: ${missing.join(", ") || "none"}`,
    )
  }
  return response
}

function retainedTerminalCommand(index: number) {
  if (process.platform === "win32") {
    return `echo memory-warm-${String(index + 1)} && ping -n 86401 127.0.0.1 >NUL`
  }
  return `printf 'memory-warm-${String(index + 1)}\n'; exec sleep 86400`
}

async function prepareMemoryFixture(port: number, template: unknown) {
  const directory = memoryWorkspaceDir
  const base = `http://127.0.0.1:${String(port)}`
  let lastFailure = "server did not answer"
  for (let attempt = 0; attempt < 120; attempt++) {
    const registration = await fetch(
      `${base}/api/claxedo/workspace/resolve?directory=${encodeURIComponent(directory)}&create=true`,
      { signal: AbortSignal.timeout(2_000) },
    ).catch(() => undefined)
    if (!registration?.ok) {
      if (registration) lastFailure = `workspace registration: ${String(registration.status)} ${await registration.text()}`
      await delay(250)
      continue
    }
    // A draft is the local unsigned idle state: a real registered workspace,
    // with no harness process and no server-side Session created yet.
    return memoryFixtureWithSession(template, "new", directory)
  }
  throw new Error(`memory profile workspace registration failed: ${lastFailure}`)
}

function memoryFixtureWithSession(template: unknown, sessionId: string, directory: string) {
  const fixture = structuredClone(asObject(template))
  const meta = asObject(asObject(fixture.meta)["memory-session-1"])
  const content = asObject(meta.content)
  const sessionRef = asObject(content.sessionRef)
  meta.sessionId = sessionId
  meta.directory = directory
  content.sessionId = sessionId
  content.directory = directory
  sessionRef.sessionId = sessionId
  sessionRef.cwd = directory
  const toolSandbox = asObject(sessionRef.toolSandbox)
  toolSandbox.cwd = directory
  sessionRef.toolSandbox = toolSandbox
  content.sessionRef = sessionRef
  meta.content = content
  asObject(fixture.meta)["memory-session-1"] = meta
  return fixture
}

async function waitForTarget() {
  for (let attempt = 0; attempt < 160; attempt++) {
    const targets = await fetch(`http://127.0.0.1:${String(cdpPort)}/json/list`)
      .then((response) => response.json() as Promise<Target[]>)
      .catch(() => [])
    const target = targets.find((item) => item.type === "page" && item.url.includes(MAIN_RENDERER_DOCUMENT))
    if (target?.webSocketDebuggerUrl) return target
    await delay(250)
  }
  throw new Error(`timed out waiting for renderer target on port ${String(cdpPort)}`)
}

async function connect(target: Target) {
  if (!target.webSocketDebuggerUrl) throw new Error("renderer target has no websocket URL")
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>()
  let id = 0
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error("DevTools websocket failed to open")), { once: true })
  })
  socket.addEventListener("message", (event) => {
    const payload = asObject(JSON.parse(String(event.data)))
    const waiter = pending.get(Number(payload.id))
    if (!waiter) return
    pending.delete(Number(payload.id))
    if (payload.error) {
      waiter.reject(new Error(JSON.stringify(payload.error)))
      return
    }
    waiter.resolve(payload.result)
  })
  return {
    close: () => socket.close(),
    send(method: string, params: JsonObject = {}) {
      const nextId = ++id
      socket.send(JSON.stringify({ id: nextId, method, params }))
      return new Promise<unknown>((resolve, reject) => pending.set(nextId, { resolve, reject }))
    },
  }
}

async function waitForExpression(activeClient: Awaited<ReturnType<typeof connect>>, expression: string) {
  for (let attempt = 0; attempt < 160; attempt++) {
    const value = await activeClient.send("Runtime.evaluate", { expression, returnByValue: true })
      .then(evaluationValue)
      .catch(() => undefined)
    if (value === true) return
    await delay(250)
  }
  throw new Error(`timed out waiting for renderer expression: ${expression}`)
}

function readProcessTable() {
  const result = Bun.spawnSync(
    ["ps", "-axo", "pid=,ppid=,rss=,time=,lstart=,command="],
    { stdout: "pipe", stderr: "pipe" },
  )
  if (!result.success) throw new Error(`ps failed: ${result.stderr.toString()}`)
  const rows = parseIdleProcessTable(result.stdout.toString())
  if (rows.length === 0) throw new Error("ps returned no parseable process rows")
  return rows
}

function currentTrackedFamily(tracker: IdleProcessFamilyTracker) {
  return tracker.survivors(readProcessTable())
}

async function sampleIdleWindow(
  tracker: IdleProcessFamilyTracker,
  requestedDurationMs: number,
  requestedIntervalMs: number,
) {
  const observations: IdleProcessFamilyObservation[] = []
  tracker.resetSamplingBaseline()
  const startedAt = Date.now()
  observations.push(tracker.observe(readProcessTable(), startedAt))
  let targetOffsetMs = Math.min(requestedIntervalMs, requestedDurationMs)
  while (targetOffsetMs <= requestedDurationMs) {
    const remainingMs = startedAt + targetOffsetMs - Date.now()
    if (remainingMs > 0) await delay(remainingMs)
    observations.push(tracker.observe(readProcessTable(), Date.now()))
    if (targetOffsetMs === requestedDurationMs) break
    targetOffsetMs = Math.min(targetOffsetMs + requestedIntervalMs, requestedDurationMs)
  }
  const endedAt = observations.at(-1)!.atMs
  return {
    startedAt,
    endedAt,
    observations,
    summary: summarizeIdleResourceWindow(observations, requestedDurationMs, requestedIntervalMs),
  }
}

async function shutdownProcessFamily(
  child: Pick<typeof app, "kill" | "exited">,
  tracker: IdleProcessFamilyTracker,
  graceMs: number,
) {
  // Capture the complete live tree before terminating the root; this preserves
  // descendant identities across the reparenting that follows root exit.
  tracker.survivors(readProcessTable())
  try {
    child.kill()
  } catch {
    // The root may already have exited; the identity tracker still owns descendants.
  }
  await delay(graceMs)
  const survivors = tracker.survivors(readProcessTable())
  for (const survivor of survivors.toReversed()) {
    try {
      process.kill(survivor.pid, "SIGTERM")
    } catch {
      // It may have exited between the process-table read and the signal.
    }
  }
  if (survivors.length > 0) await delay(500)
  const stubborn = tracker.survivors(readProcessTable())
  for (const survivor of stubborn.toReversed()) {
    try {
      process.kill(survivor.pid, "SIGKILL")
    } catch {
      // It may have exited between the process-table read and the signal.
    }
  }
  await Promise.race([child.exited, delay(1_000)])
  return survivors
}

function processRole(process: IdleProcessRow, mainPid: number) {
  if (process.pid === mainPid) return "main"
  if (process.command.includes("--type=gpu-process")) return "gpu"
  if (process.command.includes("--type=renderer")) return "renderer"
  if (process.command.includes("claxedo-engine-worker")) return "opencode-compat-worker"
  if (
    process.command.includes("--utility-sub-type=node.mojom.NodeService") ||
    process.command.includes("claxedo-server/index.js")
  ) return "server"
  const utility = process.command.match(/--utility-sub-type=([^\s]+)/)?.[1]
  if (utility) return `utility:${utility}`
  if (process.command.includes("--type=utility")) return "utility"
  if (process.command.includes("crashpad_handler")) return "crashpad"
  return "other"
}

function nativeFootprint(processes: IdleProcessRow[]) {
  const result = Bun.spawnSync([
    "footprint",
    ...processes.flatMap((process) => ["-p", String(process.pid)]),
    "--swapped",
    "--wired",
    "--sort",
    "dirty",
  ], { stdout: "pipe", stderr: "pipe" })
  if (!result.success) throw new Error(`footprint failed: ${result.stderr.toString()}`)
  const output = result.stdout.toString()
  const byPid = new Map<number, number>()
  for (const match of output.matchAll(/^.+ \[(\d+)\]:.*Footprint: ([\d.]+) (KB|MB|GB)/gm)) {
    byPid.set(Number(match[1]), toMiB(Number(match[2]), match[3]))
  }
  const summaryMatch = output.match(/Summary Footprint: ([\d.]+) (KB|MB|GB)/)
  const summary = summaryMatch ? toMiB(Number(summaryMatch[1]), summaryMatch[2]) : 0
  const summarySection = output.slice(output.indexOf("Summary Footprint:"))
  const iosurfaceMatch = summarySection.match(/^\s*([\d.]+) (KB|MB|GB).*IOSurface\s*$/m)
  return {
    byPid,
    summary,
    iosurface: iosurfaceMatch ? toMiB(Number(iosurfaceMatch[1]), iosurfaceMatch[2]) : 0,
  }
}

function evaluationValue(result: unknown) {
  return asObject(asObject(result).result).value
}

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object") return {}
  return value as JsonObject
}

function toMiB(value: number, unit: string) {
  if (unit === "GB") return round(value * 1024)
  if (unit === "KB") return round(value / 1024)
  return round(value)
}

function round(value: number) {
  return Math.round(value * 10) / 10
}

function positiveDuration(name: string, fallback: number) {
  const raw = Bun.env[name]
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive duration in milliseconds`)
  return value
}

function positiveInteger(name: string, fallback: number) {
  const value = positiveDuration(name, fallback)
  if (!Number.isInteger(value)) throw new Error(`${name} must be a positive integer`)
  return value
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
