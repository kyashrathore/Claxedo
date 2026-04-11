import path from "path"
import { spawn, type ChildProcess } from "child_process"
import { TextDecoder } from "util"
import type { SandboxHandle } from "./cloud/sandbox-handle"
import { claxedoBus, globalBus, type ClaxedoEvent, type GlobalEvent } from "./bus"
import { getRuntimeConfigSnapshot, type RuntimeConfigSnapshot } from "./agent-config"
import { Log } from "./log"
import { findFreePort } from "./process/portpick"
import { getWorkspace, type Workspace } from "./workspace-store"
import { WORKSPACE_DIR } from "./cloud/sandbox-image"
import { getHarnessMode } from "./architecture"
import { listPolicies } from "./network/policy"
import { resolveSandboxNetworkPolicy } from "./network/resolve"
import * as pool from "./cloud/sandbox-pool"
import * as sandboxRuntime from "./cloud/sandbox-runtime"

const log = Log.create({ service: "workspace-supervisor" })

const IDLE_MS = 10 * 60 * 1000
const BACKOFF_MAX_MS = 30_000

type Opts = {
  server_url: string
  opencode_url: string
}

type State = {
  ws: Workspace
  child?: ChildProcess
  port?: number
  url?: string
  status: "stopped" | "starting" | "ready" | "backoff"
  started_at?: number
  used_at: number
  crashes: number
  retry_at: number
  active: number
  start?: Promise<State>
  stop?: ReturnType<typeof setTimeout>
  events?: AbortController
  global?: AbortController
  remote?: boolean
  sandbox_id?: string
  sandbox?: SandboxHandle
  health_monitor?: ReturnType<typeof setInterval>
}

let opts: Opts | undefined

const runtimes = new Map<string, State>()
const ptys = new Map<string, string>()

function needOpts() {
  if (!opts) throw new Error("workspace supervisor not configured")
  return opts
}

function now() {
  return Date.now()
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function state(ws: Workspace) {
  const hit = runtimes.get(ws.id)
  if (hit) return hit
  const created: State = {
    ws,
    status: "stopped",
    used_at: now(),
    crashes: 0,
    retry_at: 0,
    active: 0,
  }
  runtimes.set(ws.id, created)
  return created
}

async function currentSnapshot() {
  return getRuntimeConfigSnapshot()
}

async function waitForHealth(url: string) {
  const until = now() + 20_000
  let err = "workspace runtime not ready"
  while (now() < until) {
    try {
      const res = await fetch(`${url}/api/wr/health`, {
        signal: AbortSignal.timeout(2_000),
      })
      if (res.ok) return
      err = `${res.status} ${res.statusText}`
    } catch (cause) {
      err = cause instanceof Error ? cause.message : String(cause)
    }
    await sleep(250)
  }
  throw new Error(err)
}

async function push(state: State, cfg?: RuntimeConfigSnapshot) {
  if (!state.url) throw new Error("workspace runtime missing url")
  const body = cfg ?? (await currentSnapshot())
  const res = await fetch(`${state.url}/api/wr/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  })
  if (!res.ok) {
    throw new Error(`config push failed: ${res.status} ${res.statusText}`)
  }
}

async function active(state: State) {
  if (!state.url) return false
  try {
    const res = await fetch(`${state.url}/api/wr/health`, {
      signal: AbortSignal.timeout(2_000),
    })
    if (!res.ok) return false
    const body = await res.json().catch(() => ({})) as {
      ptyCount?: number
      activeProcessCount?: number
    }
    return (body.ptyCount ?? 0) > 0 || (body.activeProcessCount ?? 0) > 0
  } catch {
    return false
  }
}

function clearStop(state: State) {
  if (!state.stop) return
  clearTimeout(state.stop)
  state.stop = undefined
}

function scheduleStop(state: State) {
  clearStop(state)
  state.stop = setTimeout(() => {
    void (async () => {
      if (state.active > 0 || now() - state.used_at < IDLE_MS || await active(state)) {
        scheduleStop(state)
        return
      }
      await stopRuntime(state.ws.id, "idle")
    })()
  }, IDLE_MS)
}

function publish(raw: string) {
  try {
    claxedoBus.publish(JSON.parse(raw) as ClaxedoEvent)
  } catch {}
}

function publishGlobal(raw: string, dirMap?: { remote: string; local: string }) {
  try {
    const event = JSON.parse(raw) as GlobalEvent
    let dir = event.directory ?? "global"
    if (dirMap && dir === dirMap.remote) dir = dirMap.local
    globalBus.publish({
      directory: dir,
      payload: event.payload,
    })
  } catch {}
}

async function streamEvents(state: State) {
  if (!state.url) return
  state.events?.abort()
  const ctrl = new AbortController()
  state.events = ctrl
  const dec = new TextDecoder()
  while (!ctrl.signal.aborted && state.status === "ready" && state.url) {
    try {
      const res = await fetch(`${state.url}/api/claxedo/events`, {
        headers: { Accept: "text/event-stream", "X-Daytona-Skip-Preview-Warning": "true" },
        signal: ctrl.signal,
      })
      if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`)
      const reader = res.body.getReader()
      let buf = ""
      while (!ctrl.signal.aborted) {
        const next = await reader.read()
        if (next.done) break
        buf += dec.decode(next.value, { stream: true })
        for (;;) {
          const end = buf.indexOf("\n\n")
          if (end === -1) break
          const block = buf.slice(0, end)
          buf = buf.slice(end + 2)
          const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n")
          if (data) publish(data)
        }
      }
    } catch (err) {
      if (ctrl.signal.aborted) return
      log.warn("Workspace event stream disconnected", {
        workspaceId: state.ws.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    if (!ctrl.signal.aborted) await sleep(1_000)
  }
}

async function streamGlobal(state: State) {
  if (!state.url) return
  state.global?.abort()
  const ctrl = new AbortController()
  state.global = ctrl
  const dec = new TextDecoder()
  const dirMap = state.ws.remote_directory
    ? { remote: state.ws.remote_directory, local: state.ws.directory }
    : undefined
  while (!ctrl.signal.aborted && state.status === "ready" && state.url) {
    try {
      const res = await fetch(`${state.url}/global/event`, {
        headers: { Accept: "text/event-stream", "X-Daytona-Skip-Preview-Warning": "true" },
        signal: ctrl.signal,
      })
      if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`)
      const reader = res.body.getReader()
      let buf = ""
      while (!ctrl.signal.aborted) {
        const next = await reader.read()
        if (next.done) break
        buf += dec.decode(next.value, { stream: true })
        for (;;) {
          const end = buf.indexOf("\n\n")
          if (end === -1) break
          const block = buf.slice(0, end)
          buf = buf.slice(end + 2)
          const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n")
          if (data) publishGlobal(data, dirMap)
        }
      }
    } catch (err) {
      if (ctrl.signal.aborted) return
      log.warn("Workspace global event stream disconnected", {
        workspaceId: state.ws.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    if (!ctrl.signal.aborted) await sleep(1_000)
  }
}

async function startRemoteRuntime(s: State): Promise<State> {
  s.status = "starting"
  s.used_at = now()

  try {
    sandboxRuntime.emitProvision(s.ws.id, "acquiring_sandbox")

    const rows = listPolicies(s.ws.id)
    const net = rows.length > 0
      ? await resolveSandboxNetworkPolicy(
          rows.map((e) => ({ target: e.target, kind: e.kind })),
          needOpts().server_url,
        )
      : undefined

    const sandbox = s.sandbox ?? await pool.acquire(s.ws.id, s.ws.project_id!, net)
    s.sandbox = sandbox
    s.sandbox_id = sandbox.id
    s.remote = true

    const { url } = await sandboxRuntime.deployAndStart(sandbox, s.ws.id, {
      directory: s.ws.remote_directory || WORKSPACE_DIR,
      repoUrl: s.ws.repo_url,
      envVars: {
        CLAXEDO_HARNESS_MODE: getHarnessMode(),
      },
    })
    s.url = url

    await push(s)

    s.status = "ready"
    s.started_at = now()
    s.crashes = 0
    s.retry_at = 0

    void streamEvents(s)
    void streamGlobal(s)

    scheduleStop(s)
    startRemoteHealthMonitor(s)

    log.info("remote workspace-runtime ready", {
      workspaceId: s.ws.id,
      sandboxId: sandbox.id,
      url,
    })
    return s
  } catch (err) {
    s.url = undefined
    s.crashes += 1
    s.retry_at = now() + Math.min(BACKOFF_MAX_MS, 1_000 * 2 ** Math.max(0, s.crashes - 1))
    s.status = "backoff"
    const message = err instanceof Error ? err.message : String(err)
    sandboxRuntime.emitProvision(s.ws.id, "error", { message })
    log.warn("Remote runtime start failed", {
      workspaceId: s.ws.id,
      sandboxId: s.sandbox_id,
      error: message,
    })
    throw err
  }
}

function startRemoteHealthMonitor(s: State) {
  if (s.health_monitor) clearInterval(s.health_monitor)
  s.health_monitor = setInterval(async () => {
    if (s.status !== "ready") return
    try {
      const res = await fetch(`${s.url}/api/wr/health`, {
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) {
        s.sandbox?.refreshActivity().catch(() => {})
        return
      }
    } catch {}
    log.warn("Remote runtime health check failed", { workspaceId: s.ws.id })
    s.crashes += 1
    s.status = "backoff"
    s.retry_at = now() + Math.min(BACKOFF_MAX_MS, 1_000 * 2 ** Math.max(0, s.crashes - 1))
    clearInterval(s.health_monitor)
    s.health_monitor = undefined
  }, 15_000)
}

async function startLocalRuntime(s: State): Promise<State> {
  const cfg = needOpts()
  const wait = s.retry_at - now()
  if (wait > 0) await sleep(wait)

  s.port = await findFreePort()
  s.url = `http://127.0.0.1:${s.port}`
  s.status = "starting"
  s.used_at = now()

  const root = path.resolve(import.meta.dirname, "../../workspace-runtime")
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: root,
    env: {
      ...process.env,
      CLAXEDO_WR_PORT: String(s.port),
      CLAXEDO_WR_WORKSPACE_ID: s.ws.id,
      CLAXEDO_WR_DIRECTORY: s.ws.directory,
      CLAXEDO_HARNESS_MODE: getHarnessMode(),
      OPENCODE_URL: cfg.opencode_url,
    },
    stdio: "pipe",
  })

  s.child = child
  s.started_at = now()

  child.stdout?.on("data", (chunk: Buffer) => {
    log.info("workspace-runtime stdout", {
      workspaceId: s.ws.id,
      text: chunk.toString().trim(),
    })
  })

  child.stderr?.on("data", (chunk: Buffer) => {
    log.info("workspace-runtime stderr", {
      workspaceId: s.ws.id,
      text: chunk.toString().trim(),
    })
  })

  child.once("exit", (code, signal) => {
    if (s.child !== child) return
    const stopping = s.status === "stopped"
    s.child = undefined
    s.url = undefined
    s.port = undefined
    s.events?.abort()
    s.events = undefined
    s.global?.abort()
    s.global = undefined
    clearStop(s)
    if (stopping) return
    s.crashes += 1
    s.retry_at = now() + Math.min(BACKOFF_MAX_MS, 1_000 * 2 ** Math.max(0, s.crashes - 1))
    s.status = "backoff"
    log.warn("workspace-runtime exited", {
      workspaceId: s.ws.id,
      code,
      signal,
      retryAt: s.retry_at,
    })
  })

  try {
    await waitForHealth(s.url)
    await push(s)
    s.status = "ready"
    s.crashes = 0
    s.retry_at = 0
    scheduleStop(s)
    void streamEvents(s)
    void streamGlobal(s)
    log.info("workspace-runtime ready", {
      workspaceId: s.ws.id,
      directory: s.ws.directory,
      url: s.url,
    })
    return s
  } catch (err) {
    try {
      child.kill("SIGTERM")
    } catch {}
    s.child = undefined
    s.url = undefined
    s.port = undefined
    s.crashes += 1
    s.retry_at = now() + Math.min(BACKOFF_MAX_MS, 1_000 * 2 ** Math.max(0, s.crashes - 1))
    s.status = "backoff"
    throw err
  }
}

async function startRuntime(s: State) {
  if (s.status === "ready" && s.url) {
    s.used_at = now()
    scheduleStop(s)
    return s
  }
  if (s.start) return s.start
  s.start = (async () => {
    try {
      if (s.ws.kind === "cloud") {
        return await startRemoteRuntime(s)
      }
      return await startLocalRuntime(s)
    } finally {
      s.start = undefined
    }
  })()
  return s.start
}

export function configureWorkspaceSupervisor(input: Opts) {
  opts = input
}

export async function ensureWorkspaceRuntime(workspaceId: string) {
  const ws = await getWorkspace(workspaceId)
  if (!ws) throw new Error(`workspace not found: ${workspaceId}`)
  const entry = await startRuntime(state(ws))
  entry.used_at = now()
  scheduleStop(entry)
  return entry
}

export async function syncWorkspaceRuntime(workspaceId: string) {
  const entry = await ensureWorkspaceRuntime(workspaceId)
  await push(entry)
  return entry
}

export async function broadcastRuntimeConfig() {
  const cfg = await currentSnapshot()
  await Promise.allSettled(
    [...runtimes.values()]
      .filter((item) => item.status === "ready" && item.url)
      .map((item) => push(item, cfg)),
  )
}

export function listWorkspaceRuntimes() {
  return [...runtimes.values()]
    .filter((item) => item.url && item.status === "ready")
    .map((item) => ({
      workspaceId: item.ws.id,
      directory: item.ws.directory,
      remoteDirectory: item.ws.remote_directory || item.ws.directory,
      url: item.url!,
      port: item.port!,
      status: item.status,
      started_at: item.started_at,
      used_at: item.used_at,
      active: item.active,
    }))
}

export function getSandbox(workspaceId: string) {
  return runtimes.get(workspaceId)?.sandbox
}

export function markRuntimeUse(workspaceId: string) {
  const item = runtimes.get(workspaceId)
  if (!item) return
  item.used_at = now()
  scheduleStop(item)
}

export function holdRuntime(workspaceId: string) {
  const item = runtimes.get(workspaceId)
  if (!item) return
  item.active += 1
  item.used_at = now()
  clearStop(item)
}

export function releaseRuntime(workspaceId: string) {
  const item = runtimes.get(workspaceId)
  if (!item) return
  item.active = Math.max(0, item.active - 1)
  item.used_at = now()
  scheduleStop(item)
}

export function rememberPty(id: string, workspaceId: string) {
  ptys.set(id, workspaceId)
}

export function forgetPty(id: string) {
  ptys.delete(id)
}

export function getPtyWorkspace(id: string) {
  return ptys.get(id)
}

export async function findPtyWorkspace(id: string) {
  const hit = ptys.get(id)
  if (hit) return hit
  for (const item of listWorkspaceRuntimes()) {
    try {
      const res = await fetch(`${item.url}/api/claxedo/pty/${id}`, {
        signal: AbortSignal.timeout(1_500),
      })
      if (!res.ok) continue
      ptys.set(id, item.workspaceId)
      return item.workspaceId
    } catch {}
  }
}

export async function stopRuntime(workspaceId: string, reason = "manual") {
  const item = runtimes.get(workspaceId)
  if (!item) return
  const child = item.child
  const isRemote = item.remote
  const sandbox = item.sandbox
  item.status = "stopped"
  clearStop(item)
  if (item.health_monitor) {
    clearInterval(item.health_monitor)
    item.health_monitor = undefined
  }
  item.events?.abort()
  item.events = undefined
  item.global?.abort()
  item.global = undefined
  item.child = undefined
  item.url = undefined
  item.port = undefined
  item.start = undefined

  if (isRemote && sandbox) {
    await sandboxRuntime.stopRemoteRuntime(sandbox, workspaceId)
  } else if (child) {
    await new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timeout)
        child.off("exit", finish)
        resolve()
      }
      const timeout = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {}
        finish()
      }, 3_000)
      child.once("exit", finish)
      try {
        child.kill("SIGTERM")
      } catch {}
    })
  }
  log.info("workspace-runtime stopped", { workspaceId, reason })
}

export async function shutdownWorkspaceSupervisor() {
  await Promise.allSettled([...runtimes.keys()].map((id) => stopRuntime(id, "shutdown")))
}

/**
 * Inject a pre-configured runtime entry for testing.
 * Lets integration tests simulate a cloud workspace-runtime
 * without requiring real sandbox infrastructure.
 */
export function injectRuntime(ws: Workspace, url: string) {
  const s: State = {
    ws,
    url,
    port: parseInt(new URL(url).port, 10),
    status: "ready",
    started_at: now(),
    used_at: now(),
    crashes: 0,
    retry_at: 0,
    active: 0,
    remote: true,
  }
  runtimes.set(ws.id, s)
  return s
}
