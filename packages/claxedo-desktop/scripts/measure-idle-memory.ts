#!/usr/bin/env bun

import { createRequire } from "node:module"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

type JsonObject = Record<string, unknown>
type Target = { type: string; url: string; webSocketDebuggerUrl?: string }
type ProcessRow = { pid: number; ppid: number; rssKiB: number; command: string }

const packageDir = path.resolve(import.meta.dir, "..")
const mainPath = path.join(packageDir, "out/main/index.js")
const cdpPort = Number(Bun.env.CLAXEDO_DESKTOP_CDP_PORT ?? "9460")
const serverPort = Number(Bun.env.CLAXEDO_SERVER_PORT ?? String(cdpPort + 1_000))
const idleMs = Number(Bun.env.CLAXEDO_MEMORY_IDLE_MS ?? "5000")
const fixturePath = Bun.env.CLAXEDO_MEMORY_FIXTURE
  ? path.resolve(packageDir, Bun.env.CLAXEDO_MEMORY_FIXTURE)
  : path.join(import.meta.dir, "fixtures/memory-profile/state.json")
const fixtureTemplate = await Bun.file(fixturePath).json()

if (Bun.env.CLAXEDO_MEMORY_REBUILD === "1" || !(await Bun.file(mainPath).exists())) {
  const build = Bun.spawnSync(["bun", "run", "build:inner"], {
    cwd: packageDir,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!build.success) throw new Error(`desktop build failed:\n${build.stderr.toString()}\n${build.stdout.toString()}`)
}
if (!(await Bun.file(mainPath).exists())) throw new Error(`desktop main bundle is missing: ${mainPath}`)

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

const app = Bun.spawn([
  String(createRequire(import.meta.url)("electron")),
  `--remote-debugging-port=${String(cdpPort)}`,
  mainPath,
], {
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

let client: Awaited<ReturnType<typeof connect>> | undefined
let failure: unknown

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
  const core = await verifyCore(serverPort)
  await delay(idleMs)

  await client.send("Performance.enable")
  await client.send("HeapProfiler.enable")
  await client.send("HeapProfiler.collectGarbage")
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
    throw new Error("memory profile active session surface was not ready after the idle window")
  }

  const processes = processFamily(app.pid)
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
  const rssMiB = (process?: ProcessRow) => round((process?.rssKiB ?? 0) / 1024)

  console.log(JSON.stringify({
    profile: path.basename(path.dirname(fixturePath)),
    total_rss_mib: round(processes.reduce((total, process) => total + process.rssKiB, 0) / 1024),
    renderer_ready: Number(page.rendererReady ?? 0),
    core_routes_ok: core.routes,
    terminal_smoke_ok: core.terminal,
    health_status: core.status.health,
    project_status: core.status.project,
    session_status: core.status.sessions,
    config_status: core.status.config,
    providers_status: core.status.providers,
    terminal_create_status: core.status.terminalCreate,
    terminal_delete_status: core.status.terminalDelete,
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
    process_breakdown: processes.map((process) => ({
      role: processRole(process, app.pid),
      rss_mib: rssMiB(process),
      footprint_mib: footprint.byPid.get(process.pid) ?? 0,
    })),
  }))
} catch (error) {
  failure = error
  throw error
} finally {
  client?.close()
  app.kill()
  await Promise.race([app.exited, delay(2_000)])
  if (failure) {
    const [out, err] = await Promise.all([stdout, stderr])
    if (out.trim()) console.error(out.trim())
    if (err.trim()) console.error(err.trim())
  }
  await rm(root, { recursive: true, force: true })
}

async function verifyCore(port: number) {
  const base = `http://127.0.0.1:${String(port)}`
  const directory = encodeURIComponent(memoryWorkspaceDir)
  const health = await fetch(`${base}/api/claxedo/health`)
  const project = await fetch(`${base}/project/current?directory=${directory}`)
  const sessions = await fetch(`${base}/session?directory=${directory}&roots=true`)
  const config = await fetch(`${base}/global/config`)
  const providers = await fetch(`${base}/provider?view=index`)
  const createTerminal = await fetch(`${base}/api/wr/pty?directory=${directory}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "memory-smoke", initialCommand: "printf memory-smoke; sleep 30" }),
  })
  const terminal = createTerminal.ok ? asObject(await createTerminal.json()) : {}
  const terminalId = typeof terminal.id === "string" ? terminal.id : undefined
  const deleteTerminal = terminalId
    ? await fetch(`${base}/api/wr/pty/${encodeURIComponent(terminalId)}?directory=${directory}`, { method: "DELETE" })
    : undefined
  return {
    routes: Number(
      health.ok &&
        project.ok &&
        sessions.ok &&
        Array.isArray(await sessions.json()) &&
        config.ok &&
        providers.ok,
    ),
    terminal: Number(createTerminal.ok && deleteTerminal?.ok === true),
    status: {
      health: health.status,
      project: project.status,
      sessions: sessions.status,
      config: config.status,
      providers: providers.status,
      terminalCreate: createTerminal.status,
      terminalDelete: deleteTerminal?.status ?? 0,
    },
  }
}

async function prepareMemoryFixture(port: number, template: unknown) {
  const directory = memoryWorkspaceDir
  const base = `http://127.0.0.1:${String(port)}`
  let lastFailure = "server did not answer"
  for (let attempt = 0; attempt < 120; attempt++) {
    const registration = await fetch(
      `${base}/api/workspace/resolve?directory=${encodeURIComponent(directory)}&create=true`,
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
    const target = targets.find((item) => item.type === "page" && item.url.includes("index.html"))
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

function processFamily(rootPid: number) {
  const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,rss=,command="], { stdout: "pipe", stderr: "pipe" })
  if (!result.success) throw new Error(`ps failed: ${result.stderr.toString()}`)
  const rows = result.stdout.toString().trim().split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) return []
    return [{ pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]), command: match[4] }] satisfies ProcessRow[]
  })
  const family = new Set([rootPid])
  for (let pass = 0; pass < 4; pass++) {
    rows.forEach((row) => {
      if (family.has(row.ppid)) family.add(row.pid)
    })
  }
  return rows.filter((row) => family.has(row.pid))
}

function processRole(process: ProcessRow, mainPid: number) {
  if (process.pid === mainPid) return "main"
  if (process.command.includes("--type=gpu-process")) return "gpu"
  if (process.command.includes("--type=renderer")) return "renderer"
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

function nativeFootprint(processes: ProcessRow[]) {
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

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
