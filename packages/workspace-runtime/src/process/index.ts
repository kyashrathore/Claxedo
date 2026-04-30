/**
 * Process Manager (Claxedo)
 *
 * Manages long-running user-defined processes (dev servers, watchers, etc.)
 * backed by PTY sessions. Processes are declared in the project root
 * `.claxedo/processes.jsonc` and support auto-start, restart policies,
 * deterministic workspace ports, and graceful shutdown.
 */

import { claxedoBus } from "../bus"
import { Pty } from "../pty/index"
import { Log } from "../log"
import { parse as parseJsonc } from "jsonc-parser"
import path from "path"
import fs from "fs/promises"
import { realpathSync, watch, type FSWatcher } from "node:fs"
import z from "zod"
import { zodToJsonSchema } from "zod-to-json-schema"
import { buildSafeEnv } from "../pty/env"
import { collectDiagnostics } from "./diagnostics"
import * as Lease from "./lease"
import { Process } from "./process"
import { findFreePort, findNextPort, findPidOnPort, tryPort } from "./portpick"
import * as Portless from "./portless"

// -- Global port registry (cross-workspace, outside per-directory state) ------
// Maps assigned port → workspace info so port conflict detection can tell the
// user which workspace/process occupies a port, even across workspaces.

interface PortRegistryEntry {
  processName: string
  processId: string
  directory: string
  workspace: string
}

const globalPortRegistry = new Map<number, PortRegistryEntry>()

function obj(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  return input as Record<string, unknown>
}

function code(err: unknown) {
  if (!err || typeof err !== "object") return
  const row = err as { code?: unknown }
  return typeof row.code === "string" ? row.code : undefined
}

function registerPort(port: number, entry: PortRegistryEntry): void {
  globalPortRegistry.set(port, entry)
}

function unregisterPort(port: number): void {
  globalPortRegistry.delete(port)
}

function real(dir: string) {
  try {
    return path.resolve(realpathSync.native?.(dir) ?? realpathSync(dir))
  } catch {
    return path.resolve(dir)
  }
}

// --- Per-directory state -------------------------------------------------------

interface State {
  directory: string
  configs: Map<string, Process.ProcessConfig>
  processes: Map<string, Process.ManagedProcess>
  watcher: FSWatcher | undefined
  debounceTimer: ReturnType<typeof setTimeout> | undefined
  dispose: (() => void) | undefined
}

const stateMap = new Map<string, State>()

interface WorkspaceBinding {
  id: string
  name?: string
}

const workspaceMap = new Map<string, WorkspaceBinding>()

function getState(directory: string): State {
  const key = real(directory)
  if (!stateMap.has(key)) {
    stateMap.set(key, {
      directory: key,
      configs: new Map(),
      processes: new Map(),
      watcher: undefined,
      debounceTimer: undefined,
      dispose: undefined,
    })
    initExitHandler(key)
  }
  return stateMap.get(key)!
}

// --- Directory-scoped helpers --------------------------------------------------

function workspace(directory: string): string {
  return workspaceMap.get(real(directory))?.id ?? real(directory)
}

export function workspaceName(directory: string): string | undefined {
  return workspaceMap.get(real(directory))?.name
}

export function bindWorkspace(directory: string, workspaceId?: string, workspaceName?: string) {
  if (!workspaceId) return
  const key = real(directory)
  const prev = workspaceMap.get(key)
  workspaceMap.set(key, {
    id: workspaceId,
    name: workspaceName ?? prev?.name,
  })
}

function title(directory: string): string {
  const ws = workspace(directory)
  return path.basename(ws) || ws
}

function key(directory: string, processId: string) {
  return {
    project_id: real(directory),
    workspace: workspace(directory),
    process_id: processId,
  }
}

function cfgPath(directory: string) {
  return path.join(real(directory), CONFIG_FILE)
}

function schemaPath(directory: string) {
  return path.join(real(directory), SCHEMA_FILE)
}

function legacyCfgPath(directory: string) {
  return path.join(real(directory), LEGACY_CONFIG_FILE)
}

function idle(configId: string): Process.ManagedProcess {
  return {
    configId,
    ptyId: undefined,
    status: "idle",
    restartCount: 0,
    exitCode: undefined,
    startedAt: undefined,
    exitedAt: undefined,
    assignedPort: undefined,
    conflict: undefined,
    routeConflict: undefined,
    namedUrl: undefined,
  }
}

async function mirror(directory: string, configs: Process.ProcessConfig[]) {
  const s = getState(directory)
  const keep = new Set(configs.map((config) => config.id))
  for (const config of configs) {
    if (!s.processes.has(config.id)) {
      s.processes.set(config.id, idle(config.id))
    }
  }
  for (const id of Array.from(s.processes.keys())) {
    if (!keep.has(id)) s.processes.delete(id)
  }
  await Lease.prune({
    project_id: real(directory),
    workspace: workspace(directory),
    process_ids: keep,
  })
}

function samePort(
  a: Process.ProcessConfig["port"] | undefined,
  b: Process.ProcessConfig["port"] | undefined,
) {
  if (!a && !b) return true
  if (!a || !b) return false
  return a.name === b.name && a.inject === b.inject && a.preferred === b.preferred && a.onConflict === b.onConflict
}

/**
 * Detect the worktree (git root) for a given PID by reading its cwd.
 * Returns the git toplevel, or the raw cwd if not inside a git repo.
 */
async function detectWorktreeForPid(pid: number): Promise<string | undefined> {
  try {
    const { execSync } = await import("child_process")
    const cwd = process.platform === "darwin"
      ? execSync(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null | grep ^n | cut -c2-`, { encoding: "utf-8", timeout: 5000 }).trim()
      : execSync(`readlink /proc/${pid}/cwd 2>/dev/null`, { encoding: "utf-8", timeout: 5000 }).trim()
    if (!cwd) return undefined
    try {
      return execSync(`git -C ${JSON.stringify(cwd)} rev-parse --show-toplevel 2>/dev/null`, { encoding: "utf-8", timeout: 5000 }).trim()
    } catch {
      return cwd
    }
  } catch {
    return undefined
  }
}

/**
 * Cross-reference a PID against all tracked processes in every state to surface
 * sibling-workspace info on a route conflict. Mutates the input info in place.
 */
async function augmentRouteConflictInfo(info: Process.RouteConflictInfo): Promise<void> {
  try {
    const { execSync } = await import("child_process")
    info.command = execSync(`ps -p ${info.pid} -o command=`, { encoding: "utf-8", timeout: 5000 }).trim()
  } catch {}

  for (const [, state] of stateMap) {
    for (const [configId, proc] of state.processes) {
      if (!proc.ptyId) continue
      const ptyInfo = Pty.get(proc.ptyId)
      if (ptyInfo && ptyInfo.pid === info.pid) {
        const config = state.configs.get(configId)
        info.processName = config?.name
        info.processId = configId
        info.directory = state.directory
        return
      }
    }
  }
}

/**
 * Get detailed info about what's occupying a port.
 */
async function getPortOccupier(directory: string, port: number): Promise<Process.PortConflictInfo> {
  const info: Process.PortConflictInfo = { type: "port-conflict", port }

  const registered = globalPortRegistry.get(port)
  if (registered) {
    info.processName = registered.processName
    info.processId = registered.processId
    info.directory = registered.directory
  }

  const pid = await findPidOnPort(port)
  if (!pid) return info
  info.pid = pid

  try {
    const { execSync } = await import("child_process")
    info.command = execSync(`ps -p ${pid} -o command=`, { encoding: "utf-8", timeout: 5000 }).trim()
  } catch {}

  info.directory = info.directory ?? await detectWorktreeForPid(pid)

  if (!info.processName) {
    const s = getState(directory)
    for (const [configId, proc] of s.processes) {
      if (!proc.ptyId) continue
      const ptyInfo = Pty.get(proc.ptyId)
      if (ptyInfo && ptyInfo.pid === pid) {
        const config = s.configs.get(configId)
        info.processName = config?.name
        info.processId = configId
        break
      }
    }
  }

  return info
}

export function addr(text: string) {
  if (
    !text.includes("EADDRINUSE") &&
    !/address already in use/i.test(text) &&
    !/port\s+\d{2,5}\s+is\s+already\s+in\s+use/i.test(text)
  ) return
  const hit =
    text.match(/listen\s+eaddrinuse:.*?:(\d{2,5})/i) ??
    text.match(/:(\d{2,5}):\s+bind:\s+address already in use/i) ??
    text.match(/bind:\s+address already in use.*?:(\d{2,5})/i) ??
    text.match(/address already in use .*?:(\d{2,5})/i) ??
    text.match(/port\s+(\d{2,5})\s+is\s+already\s+in\s+use/i) ??
    text.match(/\bport\s+(\d{2,5})\b/i)
  const raw = hit?.[1]
  if (!raw) return
  const port = Number(raw)
  if (!Number.isInteger(port) || port <= 0) return
  return port
}

async function conflict(directory: string, text: string | undefined, ptyId?: string, known?: number) {
  const port = addr(text ?? "")
  if (port) return await getPortOccupier(directory, port)
  if (!ptyId || !Pty.hasAddrInUse(ptyId)) return
  if (known !== undefined) return await getPortOccupier(directory, known)
  const hit = addr(Pty.snapshot(ptyId, 16_384))
  if (!hit) return
  return await getPortOccupier(directory, hit)
}

/**
 * Kill the process occupying a preferred port and reclaim it.
 */
async function killAndReclaimPort(port: number): Promise<boolean> {
  const pid = await findPidOnPort(port)
  if (!pid) {
    return await tryPort(port)
  }

  log.warn("portpick: killing existing process on preferred port", { port, pid })
  try {
    if (process.platform !== "win32") {
      try {
        process.kill(-pid, "SIGTERM")
      } catch {}
    }
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
    if (await tryPort(port)) {
      log.info("portpick: reclaimed preferred port after kill", { port })
      return true
    }
    if (process.platform !== "win32") {
      try {
        process.kill(-pid, "SIGKILL")
      } catch {}
    }
    try { process.kill(pid, "SIGKILL") } catch {}
    await new Promise((r) => setTimeout(r, 500))
    if (await tryPort(port)) return true
  } catch (err) {
    log.warn("portpick: failed to kill process on port", { port, pid, err: String(err) })
  }

  log.warn("portpick: could not reclaim preferred port", { port })
  return false
}

/**
 * Resolve a port for a process config.
 */
async function resolvePort(
  directory: string,
  config: Process.ProcessConfig,
  overrideStrategy?: Process.PortConflictStrategy,
): Promise<number | Process.PortConflictInfo> {
  if (!config.port) return await findFreePort()

  const preferred = config.port.preferred
  if (preferred === undefined) return await findFreePort()

  const hit = await Lease.read(key(directory, config.id))
  const start =
    hit && hit.port_name === config.port.name && hit.preferred === preferred
      ? hit.port
      : preferred

  if (await tryPort(start)) {
    log.info("portpick: using preferred port", {
      name: config.port.name,
      port: start,
      preferred,
      workspace: title(directory),
    })
    return start
  }

  const strategy = overrideStrategy ?? config.port.onConflict

  if (!strategy) {
    log.info("portpick: preferred port occupied, prompting user", {
      name: config.port.name,
      preferred: start,
    })
    return await getPortOccupier(directory, start)
  }

  if (strategy === "kill-existing") {
    const reclaimed = await killAndReclaimPort(start)
    if (reclaimed) return start
  } else {
    log.info("portpick: preferred port occupied, picking new", {
      name: config.port.name,
      preferred: start,
    })
  }

  return await findNextPort(start + 1)
}

function resolvePortTemplates(
  env: Record<string, string>,
  pm: Record<string, number>,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [k, value] of Object.entries(env)) {
    result[k] = value.replace(/\{\{port:([a-zA-Z0-9._-]+)\}\}/g, (_match, name) => {
      const port = pm[name]
      return port !== undefined ? String(port) : _match
    })
  }
  return result
}

/**
 * Extract port names referenced via {{port:name}} templates in a config's env vars.
 */
function extractPortDependencies(config: Process.ProcessConfig): string[] {
  if (!config.env) return []
  const names = new Set<string>()
  for (const value of Object.values(config.env)) {
    const re = /\{\{port:([a-zA-Z0-9._-]+)\}\}/g
    let m: RegExpExecArray | null
    while ((m = re.exec(value)) !== null) {
      if (m[1]) names.add(m[1])
    }
  }
  return Array.from(names)
}

function isFlag(inject: string): boolean {
  return inject.startsWith("-")
}

export { Process, configChanged }

const log = Log.create({ service: "process" })

const CONFIG_FILE = ".claxedo/processes.jsonc"
const SCHEMA_FILE = ".claxedo/processes.schema.json"
const LEGACY_CONFIG_FILE = ".opencode/processes.jsonc"

/**
 * Write the JSON Schema for processes.jsonc so editors provide autocompletion.
 */
async function writeSchema(directory: string): Promise<void> {
  try {
    const raw = zodToJsonSchema(Process.ProcessConfigFile)
    const root = obj(raw)
    const props = obj(root?.properties)
    const procs = obj(props?.processes)
    const items = obj(procs?.items)
    const itemProps = obj(items?.properties)
    const id = obj(itemProps?.id)
    if (id && "default" in id) {
      delete id.default
    }
    if (Array.isArray(items?.required) && itemProps) {
      items.required = items.required.filter((field): field is string => {
        if (typeof field !== "string") return false
        const item = obj(itemProps[field])
        return !("default" in (item ?? {}))
      })
    }
    if (Array.isArray(items?.required) && itemProps?.id) {
      items.required = Array.from(new Set([...items.required, "id"]))
    }
    await fs.mkdir(path.dirname(schemaPath(directory)), { recursive: true })
    await fs.writeFile(schemaPath(directory), JSON.stringify(raw, null, 2) + "\n", "utf-8")
  } catch (err) {
    log.warn("failed to write process schema", { err: String(err) })
  }
}

/**
 * Load process configs from the project root `.claxedo/processes.jsonc`.
 */
export async function loadConfig(directory: string): Promise<Process.ProcessConfig[]> {
  const filePath = cfgPath(directory)
  const legacyPath = legacyCfgPath(directory)
  let sourcePath = filePath
  let content: string

  try {
    try {
      content = await fs.readFile(filePath, "utf-8")
    } catch (err) {
      if (code(err) !== "ENOENT") throw err
      content = await fs.readFile(legacyPath, "utf-8")
      sourcePath = legacyPath
    }
    const raw = parseJsonc(content)
    const parsed = Process.ProcessConfigFile.parse(raw)
    const rawProcesses = obj(raw)?.processes
    const shouldPersist =
      sourcePath === legacyPath ||
      (Array.isArray(rawProcesses) && rawProcesses.some((item) => !obj(item)?.id))
    const s = getState(directory)
    s.configs.clear()
    for (const config of parsed.processes) {
      s.configs.set(config.id, config)
    }
    await mirror(directory, parsed.processes)
    log.info("loaded process configs", { count: parsed.processes.length })
    if (shouldPersist) {
      await saveConfig(directory, parsed.processes)
    } else {
      void writeSchema(directory)
    }
    return parsed.processes
  } catch (err) {
    if (code(err) === "ENOENT") {
      log.info("no process config file found", { path: filePath })
      const s = getState(directory)
      s.configs.clear()
      s.processes.clear()
      await Lease.prune({
        project_id: real(directory),
        workspace: workspace(directory),
        process_ids: new Set(),
      })
      return []
    }
    log.error("failed to load process config", { path: sourcePath, err: String(err) })
    return []
  }
}

/**
 * Write process configs to `.claxedo/processes.jsonc`.
 */
export async function saveConfig(directory: string, configs: Process.ProcessConfig[]): Promise<void> {
  const filePath = cfgPath(directory)
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })

  const file: Process.ProcessConfigFile = {
    $schema: "./processes.schema.json",
    processes: configs,
  }
  await fs.writeFile(filePath, JSON.stringify(file, null, 2) + "\n", "utf-8")
  void writeSchema(directory)

  const s = getState(directory)
  s.configs.clear()
  for (const config of configs) {
    s.configs.set(config.id, config)
  }
  await mirror(directory, configs)

  claxedoBus.publish({ type: "process.config.changed", directory: real(directory), configs })
  log.info("saved process configs", { count: configs.length })
}

/**
 * Watch the project root `.claxedo/processes.jsonc` for changes.
 */
export function watchConfig(directory: string): void {
  const s = getState(directory)

  if (s.watcher) {
    try {
      s.watcher.close()
    } catch {}
    s.watcher = undefined
  }

  const dirPath = path.dirname(cfgPath(directory))
  const filename = path.basename(cfgPath(directory))

  try {
    const watcher = watch(dirPath, (eventType, changedFile) => {
      if (changedFile !== filename) return

      if (s.debounceTimer) clearTimeout(s.debounceTimer)
      s.debounceTimer = setTimeout(() => {
        s.debounceTimer = undefined
        reconcileFromDisk(directory)
      }, 100)
    })

    watcher.on("error", (err) => {
      log.warn("config watcher error", { err: String(err) })
    })

    s.watcher = watcher
    log.info("watching config file", { path: cfgPath(directory) })
  } catch (err) {
    if (code(err) === "ENOENT") {
      log.info("config directory does not exist, skipping watcher", { dir: dirPath })
      return
    }
    log.error("failed to start config watcher", { err: String(err) })
  }
}

/**
 * Re-read the config file from disk and reconcile with current state.
 */
async function reconcileFromDisk(directory: string): Promise<void> {
  const s = getState(directory)
  const filePath = cfgPath(directory)

  let newConfigs: Process.ProcessConfig[]

  try {
    const content = await fs.readFile(filePath, "utf-8")
    const raw = parseJsonc(content)
    const parsed = Process.ProcessConfigFile.safeParse(raw)

    if (!parsed.success) {
      log.warn("config parse error on file change, keeping current configs", {
        path: filePath,
        error: String(parsed.error),
      })
      return
    }

    newConfigs = parsed.data.processes
  } catch (err) {
    if (code(err) === "ENOENT") {
      log.info("config file deleted, stopping all processes")
      await stopAll(directory)
      s.configs.clear()
      s.processes.clear()
      await Lease.prune({
        project_id: real(directory),
        workspace: workspace(directory),
        process_ids: new Set(),
      })
      claxedoBus.publish({ type: "process.config.changed", directory: real(directory), configs: [] })
      return
    }
    log.error("failed to read config on change", { path: filePath, err: String(err) })
    return
  }

  const oldIds = new Set(s.configs.keys())
  const newById = new Map(newConfigs.map((c) => [c.id, c]))
  const newIds = new Set(newById.keys())

  for (const id of oldIds) {
    if (!newIds.has(id)) {
      const proc = s.processes.get(id)
      if (proc && (proc.status === "running" || proc.status === "starting" || proc.status === "restarting")) {
        await stop(directory, id)
      }
      await Lease.drop(key(directory, id))
      s.configs.delete(id)
      s.processes.delete(id)
      log.info("config removed", { id })
    }
  }

  for (const [id, config] of newById) {
    if (!oldIds.has(id)) {
      s.configs.set(id, config)
      s.processes.set(id, idle(id))
      log.info("config added", { id, name: config.name })
    }
  }

  for (const [id, newConfig] of newById) {
    if (oldIds.has(id)) {
      const oldConfig = s.configs.get(id)!
      if (configChanged(oldConfig, newConfig)) {
        if (!samePort(oldConfig.port, newConfig.port)) {
          await Lease.drop(key(directory, id))
        }
        s.configs.set(id, newConfig)
        const proc = s.processes.get(id)
        if (proc && (proc.status === "running" || proc.status === "starting" || proc.status === "restarting")) {
          log.info("config changed, restarting process", { id, name: newConfig.name })
          await restart(directory, id)
        } else {
          log.info("config changed", { id, name: newConfig.name })
        }
      } else {
        s.configs.set(id, newConfig)
      }
    }
  }

  await mirror(directory, newConfigs)
  claxedoBus.publish({ type: "process.config.changed", directory: real(directory), configs: newConfigs })
  log.info("config reconciled from disk", { count: newConfigs.length })
}

/**
 * Check if two process configs differ in execution-relevant fields.
 */
function configChanged(a: Process.ProcessConfig, b: Process.ProcessConfig): boolean {
  if (a.command !== b.command) return true
  if (JSON.stringify(a.args) !== JSON.stringify(b.args)) return true
  if (a.cwd !== b.cwd) return true
  if (JSON.stringify(a.env) !== JSON.stringify(b.env)) return true
  if (a.restartPolicy !== b.restartPolicy) return true
  if (a.maxRestarts !== b.maxRestarts) return true
  if (JSON.stringify(a.dependsOn) !== JSON.stringify(b.dependsOn)) return true
  return !samePort(a.port, b.port)
}

/**
 * Resolve the ordered list of config IDs that must be started before this one.
 */
function deps(directory: string, configId: string, pick?: Set<string>): string[] {
  const s = getState(directory)
  const config = s.configs.get(configId)
  if (!config) return []

  const depIds = new Set<string>()

  if (config.dependsOn) {
    for (const depName of config.dependsOn) {
      const found = findConfigByName(directory, depName)
      if (found) {
        depIds.add(found.id)
      } else {
        log.warn("dependsOn: referenced process not found", { configId, dependsOn: depName })
      }
    }
  }

  const portDeps = extractPortDependencies(config)
  for (const portName of portDeps) {
    if (config.port?.name === portName) continue
    for (const [id, c] of s.configs) {
      if (c.port?.name === portName && id !== configId && (!pick || pick.has(id))) {
        depIds.add(id)
      }
    }
  }

  return Array.from(depIds).filter((id) => !pick || pick.has(id))
}

function resolveDependencyOrder(directory: string, configId: string): string[] {
  const order: string[] = []
  const added = new Set<string>()
  const seen = new Set<string>()
  const stack = new Set<string>()

  function visit(id: string) {
    if (stack.has(id)) {
      throw new Error(`Circular dependency detected involving process: ${id}`)
    }
    if (seen.has(id)) return

    stack.add(id)
    for (const depId of deps(directory, id)) {
      visit(depId)
      if (!added.has(depId)) {
        added.add(depId)
        order.push(depId)
      }
    }
    stack.delete(id)
    seen.add(id)
  }

  visit(configId)
  return order
}

/**
 * Find a process config by display name (case-insensitive).
 */
function findConfigByName(directory: string, name: string): Process.ProcessConfig | undefined {
  const s = getState(directory)
  const lower = name.toLowerCase()
  for (const config of s.configs.values()) {
    if (config.name.toLowerCase() === lower) return config
  }
  return undefined
}

async function ready(directory: string, configId: string, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const s = getState(directory)
    const config = s.configs.get(configId)
    const proc = s.processes.get(configId)
    if (!config || !proc) return false
    if (proc.status === "crashed" || proc.status === "stopped" || proc.status === "idle") return false
    if (!config.port) {
      if (proc.status === "running") return true
    } else if (proc.assignedPort !== undefined && await findPidOnPort(proc.assignedPort)) {
      return true
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

function miss(error = "Process config not found"): Process.LaunchResult {
  return { kind: "not_found", error }
}

function fail(error: string, process?: Process.ManagedProcess): Process.LaunchResult {
  return {
    kind: "failed",
    error,
    ...(process ? { process } : {}),
  }
}

async function gone(ptyId: string, ms: number) {
  if (!Pty.get(ptyId)) return true
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      unsub()
      resolve(!Pty.get(ptyId))
    }, ms)
    const unsub = claxedoBus.subscribe((event) => {
      if (event.type !== "pty.exited") return
      if (event.id !== ptyId) return
      clearTimeout(timer)
      unsub()
      resolve(true)
    })
  })
}

async function reap(rows: Process.DiagnosticOsProcess[]) {
  if (rows.length === 0) return
  const groups = [...new Set(rows.flatMap((row) => (row.pgid > 0 ? [row.pgid] : [])))]
  const ids = [...new Set(rows.map((row) => row.pid).filter((pid) => Number.isFinite(pid) && pid > 0))]
  if (process.platform !== "win32") {
    for (const pgid of groups) {
      try {
        process.kill(-pgid, "SIGKILL")
      } catch (err) {
        if ((err as NodeJS.ErrnoException | undefined)?.code !== "ESRCH") throw err
      }
    }
  }
  for (const id of ids) {
    try {
      process.kill(id, "SIGKILL")
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code !== "ESRCH") throw err
    }
  }
}

function scrub(directory: string, configId: string, nextStatus?: Process.Status) {
  const s = getState(directory)
  const prev = s.processes.get(configId)
  if (!prev) return

  if (prev.assignedPort !== undefined) {
    unregisterPort(prev.assignedPort)
  }

  const status = nextStatus ?? (prev.status === "crashed" ? "crashed" : "stopped")
  const next: Process.ManagedProcess = {
    ...prev,
    status,
    ptyId: undefined,
    assignedPort: undefined,
    exitedAt: prev.exitedAt ?? Date.now(),
    conflict: undefined,
  }
  s.processes.set(configId, next)

  if (status === "stopped" && prev.status !== "stopped") {
    claxedoBus.publish({ type: "process.stopped", directory: real(directory), configId, exitCode: next.exitCode ?? 0 })
  }
  if (prev.status !== status || prev.ptyId !== next.ptyId || prev.assignedPort !== next.assignedPort) {
    claxedoBus.publish({ type: "process.status", directory: real(directory), configId, status })
  }
}

export async function reconcileRuntime(directory: string, ids?: string[]): Promise<void> {
  const s = getState(directory)
  const pick = ids ?? Array.from(s.configs.keys())
  if (pick.length === 0) return

  const snap = await collectDiagnostics({
    directory: workspace(directory),
    configs: configs(directory),
    processes: list(directory),
    ptys: Pty.listDetailed(),
  }).catch(() => undefined)

  if (snap) {
    const rows = snap.os.filter((row) => {
      return row.process_id !== undefined && pick.includes(row.process_id) && row.workspace_id === workspace(directory)
    })
    const stale = rows.filter((row) => {
      const proc = s.processes.get(row.process_id!)
      if (!proc?.ptyId) return true
      const info = Pty.get(proc.ptyId)
      if (!info) return true
      return !["running", "starting", "restarting"].includes(proc.status)
    })
    if (stale.length > 0) {
      await reap(stale)
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  for (const configId of pick) {
    const proc = s.processes.get(configId)
    if (!proc) continue
    const info = proc.ptyId ? Pty.get(proc.ptyId) : undefined
    if (!info && ["running", "starting", "restarting", "stopping"].includes(proc.status)) {
      scrub(directory, configId, "stopped")
      continue
    }
    if (!info && proc.assignedPort !== undefined) {
      scrub(directory, configId, proc.status)
    }
  }
}

/**
 * Start a process by config ID.
 */
export async function start(
  directory: string,
  configId: string,
  opts?: { portConflict?: Process.PortConflictStrategy; routeConflict?: Process.PortConflictStrategy },
): Promise<Process.LaunchResult> {
  const s = getState(directory)
  const config = s.configs.get(configId)
  if (!config) {
    log.error("config not found", { configId })
    return miss()
  }

  const existing = s.processes.get(configId)
  if (existing && (existing.status === "running" || existing.status === "starting")) {
    log.info("process already running", { configId, status: existing.status })
    return {
      kind: "already_running",
      process: existing,
    }
  }
  if (existing?.status === "crashed" && existing.ptyId) {
    await stop(directory, configId)
  }

  // --- Auto-start dependencies ---
  try {
    const depOrder = resolveDependencyOrder(directory, configId)
    for (const depId of depOrder) {
      const depProc = s.processes.get(depId)
      if (depProc && (depProc.status === "running" || depProc.status === "starting")) continue
      const depConfig = s.configs.get(depId)
      log.info("auto-starting dependency", { configId, dependency: depConfig?.name ?? depId })
      const started = await start(directory, depId, { portConflict: "pick-new" })
      if (started.kind !== "started" && started.kind !== "already_running") {
        log.error("dependency failed to start", {
          configId,
          dependency: depConfig?.name ?? depId,
          kind: started.kind,
          error: "error" in started ? started.error : undefined,
        })
        return fail(`Dependency failed to start: ${depConfig?.name ?? depId}`)
      }
      if (!(await ready(directory, depId))) {
        log.error("dependency did not become ready", { configId, dependency: depConfig?.name ?? depId })
        return fail(`Dependency did not become ready: ${depConfig?.name ?? depId}`)
      }
    }
  } catch (err) {
    log.error("dependency resolution failed", { configId, err: String(err) })
    return fail(`Dependency resolution failed: ${String(err)}`)
  }

  const cwd = config.cwd ? path.resolve(directory, config.cwd) : directory

  // --- Port assignment ---
  let assignedPort: number | undefined
  if (config.port) {
    const portResult = await resolvePort(directory, config, opts?.portConflict)
    if (typeof portResult === "object") {
      s.processes.set(configId, {
        ...(existing ?? idle(configId)),
        configId,
        ptyId: undefined,
        status: "crashed",
        exitCode: undefined,
        exitedAt: Date.now(),
        assignedPort: undefined,
        conflict: portResult,
      })
      claxedoBus.publish({ type: "process.status", directory: real(directory), configId, status: "crashed" })
      return {
        kind: "port_conflict",
        conflict: portResult,
      }
    }
    assignedPort = portResult
    log.info("portpick: assigned port", { configId, name: config.port.name, port: assignedPort })
  }

  // --- Portless route assignment (pre-spawn dry-run) ---
  // Compute the target hostname and check for cross-workspace collision before
  // we spawn the PTY. Skipped silently if Portless isn't installed/running.
  // All Portless library calls go through the wrappers in ./portless so an
  // exception cannot escape and abort start().
  let portlessProxy: Portless.ProxyState | null = null
  let portlessHostname: string | null = null
  let portlessStore: ReturnType<typeof Portless.openStore> = null
  if (config.port) {
    try {
      portlessProxy = Portless.detectProxy()
      if (portlessProxy) {
        // Fall back to the directory basename when no workspace name is bound.
        // This is the local-dev case where claxedo-server isn't proxying and the
        // x-workspace-name header is never set.
        const wsName = workspaceName(directory) ?? path.basename(real(directory))
        portlessHostname = Portless.deriveHostname({
          portName: config.port.name,
          workspaceName: wsName,
          workspaceId: workspaceMap.get(real(directory))?.id,
          tld: portlessProxy.tld,
          withDiscriminator: opts?.routeConflict === "pick-new",
        })
        if (portlessHostname) {
          portlessStore = Portless.openStore(portlessProxy.stateDir)
          if (portlessStore && opts?.routeConflict !== "kill-existing") {
            const dry = Portless.dryRunCheck(portlessStore, portlessHostname)
            if (dry) {
              const info = Portless.makeRouteConflictInfo(dry.hostname, dry.pid)
              await augmentRouteConflictInfo(info)
              s.processes.set(configId, {
                ...(existing ?? idle(configId)),
                configId,
                ptyId: undefined,
                status: "crashed",
                exitCode: undefined,
                exitedAt: Date.now(),
                assignedPort: undefined,
                conflict: undefined,
                routeConflict: info,
                namedUrl: undefined,
              })
              claxedoBus.publish({ type: "process.status", directory: real(directory), configId, status: "crashed" })
              return {
                kind: "route_conflict",
                conflict: info,
              }
            }
          }
        }
      }
    } catch (err) {
      // The wrappers should already swallow Portless library errors, but a defense-
      // in-depth try/catch here ensures `start()` never aborts on a Portless surprise.
      log.warn("portless pre-spawn failed; continuing without named URL", { err: String(err) })
      portlessProxy = null
      portlessHostname = null
      portlessStore = null
    }
  }

  const pm = portMap(directory)
  if (config.port && assignedPort !== undefined) {
    pm[config.port.name] = assignedPort
  }

  const env: Record<string, string> = {
    ...buildSafeEnv(process.env, { customPrefix: "CLAXEDO" }),
    ...resolvePortTemplates(config.env || {}, pm),
    OPENCODE_TERMINAL: "1",
    OPENCODE_PROCESS: config.name,
    OPENCODE_PROCESS_ID: configId,
    CLAXEDO_WORKSPACE_ID: workspace(directory),
  }

  const proc: Process.ManagedProcess = {
    configId,
    ptyId: undefined,
    status: "starting",
    restartCount: existing?.restartCount ?? 0,
    exitCode: undefined,
    startedAt: Date.now(),
    exitedAt: undefined,
    assignedPort,
    conflict: undefined,
  }
  s.processes.set(configId, proc)
  claxedoBus.publish({ type: "process.status", directory: real(directory), configId, status: "starting" })

  try {
    const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh")
    let fullCommand = config.args?.length
      ? [config.command, ...config.args].join(" ")
      : config.command

    if (config.port && assignedPort !== undefined) {
      env.CLAXEDO_PORT = String(assignedPort)
      if (isFlag(config.port.inject)) {
        fullCommand = `${fullCommand} ${config.port.inject} ${assignedPort}`
      } else {
        env[config.port.inject] = String(assignedPort)
      }
    }

    const info = await Pty.create({
      command: shell,
      args: [],
      cwd,
      title: config.name,
      env,
      managed: true,
    })

    proc.ptyId = info.id
    proc.status = "running"
    s.processes.set(configId, proc)

    // Brief delay to let the shell enter raw mode before we write. 50ms is
    // enough on macOS/Linux for zsh/bash to be ready; longer waits show up
    // as perceived "Start" lag in the UI.
    await new Promise((r) => setTimeout(r, 50))
    try {
      Pty.write(info.id, fullCommand + "; printf '\\033]777;process-exit;%d\\007' $?\n")
    } catch (e) {
      log.warn("failed to write command to process shell", { configId, ptyId: info.id, err: String(e) })
    }

    if (assignedPort !== undefined) {
      registerPort(assignedPort, {
        processName: config.name,
        processId: configId,
        directory: workspace(directory),
        workspace: title(directory),
      })
    }
    if (config.port?.preferred !== undefined && assignedPort !== undefined) {
      await Lease.write({
        ...key(directory, config.id),
        port_name: config.port.name,
        preferred: config.port.preferred,
        port: assignedPort,
      })
    }

    // --- Portless route registration (post-spawn) ---
    // Register the alias now that we have info.pid. PID-liveness self-cleans on
    // shell exit, so no removeRoute is needed on stop. On race-loss conflict
    // (sibling registered between dry-run and now), tear down the PTY and surface
    // the conflict to the caller.
    if (portlessProxy && portlessHostname && portlessStore && assignedPort !== undefined) {
      const force = opts?.routeConflict === "kill-existing"
      const result = Portless.tryRegister(portlessStore, portlessHostname, assignedPort, info.pid, force)
      if (result.ok) {
        const formatted = Portless.safeFormatUrl(portlessHostname, portlessProxy.proxyPort, portlessProxy.tls)
        if (formatted) proc.namedUrl = formatted
        s.processes.set(configId, proc)
        log.info("portless: route registered", {
          configId,
          hostname: portlessHostname,
          port: assignedPort,
        })
      } else if (result.kind === "conflict") {
        log.warn("portless: race lost, tearing down PTY", { configId, hostname: portlessHostname, pid: result.pid })
        if (process.platform !== "win32") {
          try { process.kill(-info.pid, "SIGKILL") } catch {}
        }
        try { process.kill(info.pid, "SIGKILL") } catch {}
        try { await Pty.remove(info.id) } catch {}
        unregisterPort(assignedPort)
        // Reverse the lease + portMap mutations performed earlier in this start()
        // call so they don't bias the next launch toward an unused port name.
        if (config.port) {
          delete pm[config.port.name]
          if (config.port.preferred !== undefined) {
            try { await Lease.drop(key(directory, config.id)) } catch {}
          }
        }
        const conflictInfo = Portless.makeRouteConflictInfo(result.hostname, result.pid)
        await augmentRouteConflictInfo(conflictInfo)
        proc.status = "crashed"
        proc.assignedPort = undefined
        proc.ptyId = undefined
        proc.exitedAt = Date.now()
        proc.routeConflict = conflictInfo
        s.processes.set(configId, proc)
        claxedoBus.publish({ type: "process.crashed", directory: real(directory), configId, exitCode: 1, restartCount: proc.restartCount })
        claxedoBus.publish({ type: "process.status", directory: real(directory), configId, status: "crashed" })
        return {
          kind: "route_conflict",
          conflict: conflictInfo,
        }
      }
      // result.kind === "error" → already logged in tryRegister; leave namedUrl unset and continue.
    }

    claxedoBus.publish({ type: "process.started", directory: real(directory), configId, ptyId: info.id })
    claxedoBus.publish({ type: "process.status", directory: real(directory), configId, status: "running" })
    log.info("process started", { configId, name: config.name, ptyId: info.id, port: assignedPort })

    return {
      kind: "started",
      process: proc,
    }
  } catch (err) {
    proc.status = "crashed"
    proc.assignedPort = undefined
    proc.exitedAt = Date.now()
    s.processes.set(configId, proc)
    claxedoBus.publish({ type: "process.status", directory: real(directory), configId, status: "crashed" })
    log.error("failed to start process", { configId, err: String(err) })
    return fail(`Failed to start process: ${String(err)}`, proc)
  }
}

/**
 * Stop a process by config ID or pty ID.
 */
export async function stop(directory: string, configIdOrPtyId: string, signal?: string): Promise<void> {
  const s = getState(directory)
  const { configId, proc } = resolveProcess(directory, configIdOrPtyId)
  if (!proc) {
    log.info("no running process to stop", { id: configIdOrPtyId })
    return
  }
  if (!proc.ptyId) {
    scrub(directory, configId, proc.status === "crashed" ? "crashed" : "stopped")
    await reconcileRuntime(directory, [configId])
    return
  }

  if (proc.assignedPort !== undefined) {
    unregisterPort(proc.assignedPort)
  }

  const updated: Process.ManagedProcess = { ...proc, status: "stopping" }
  s.processes.set(configId, updated)
  claxedoBus.publish({ type: "process.status", directory: real(directory), configId, status: "stopping" })

  const ptyId = proc.ptyId

  if (!signal || signal === "SIGTERM") {
    try {
      Pty.write(ptyId, "\x03")
    } catch {}
  }

  let done = await gone(ptyId, signal ? 250 : 2000)
  if (!done) {
    const info = Pty.get(ptyId)
    if (signal === "SIGKILL" && info) {
      if (process.platform !== "win32") {
        try {
          process.kill(-info.pid, "SIGKILL")
        } catch {}
      }
      try {
        process.kill(info.pid, "SIGKILL")
      } catch {}
    } else {
      try {
        await Pty.remove(ptyId)
      } catch {}
    }
    done = await gone(ptyId, 2000)
  }
  if (!done) {
    const info = Pty.get(ptyId)
    if (info) {
      if (process.platform !== "win32") {
        try {
          process.kill(-info.pid, "SIGKILL")
        } catch {}
      }
      try {
        process.kill(info.pid, "SIGKILL")
      } catch {}
    }
    await gone(ptyId, 1000)
  }

  scrub(directory, configId, "stopped")
  await reconcileRuntime(directory, [configId])
  log.info("process stopped", { configId, ptyId })
}

/**
 * Restart a process by config ID or pty ID.
 */
export async function restart(directory: string, configIdOrPtyId: string): Promise<Process.LaunchResult> {
  const { configId } = resolveProcess(directory, configIdOrPtyId)
  if (!getState(directory).configs.has(configId)) return miss()
  await stop(directory, configId)

  const s = getState(directory)
  const existing = s.processes.get(configId)
  if (existing) {
    existing.restartCount = 0
    s.processes.set(configId, existing)
  }

  const result = await start(directory, configId, { portConflict: "pick-new" })
  if (result.kind === "port_conflict") {
    return fail(`Unexpected port conflict while restarting process: ${configId}`)
  }
  return result
}

/**
 * Topologically sort configs by dependencies.
 */
function topologicalSort(directory: string, configIds: string[]): string[] {
  const s = getState(directory)
  const idSet = new Set(configIds)
  const visited = new Set<string>()
  const result: string[] = []

  function visit(id: string, stack: Set<string>) {
    if (visited.has(id)) return
    if (stack.has(id)) {
      log.warn("circular dependency detected during topological sort, skipping", { id })
      return
    }
    stack.add(id)

    if (!s.configs.has(id)) {
      stack.delete(id)
      return
    }

    for (const depId of deps(directory, id, idSet)) {
      visit(depId, stack)
    }

    stack.delete(id)
    visited.add(id)
    result.push(id)
  }

  for (const id of configIds) {
    visit(id, new Set())
  }
  return result
}

/**
 * Start all processes with autoStart=true that are not already running.
 */
export async function startAll(directory: string): Promise<void> {
  const s = getState(directory)
  await reconcileRuntime(directory)
  const autoStartIds = Array.from(s.configs.entries())
    .filter(([, config]) => config.autoStart)
    .map(([id]) => id)

  const allIds = new Set<string>(autoStartIds)
  for (const id of autoStartIds) {
    try {
      const depIds = resolveDependencyOrder(directory, id)
      for (const depId of depIds) allIds.add(depId)
    } catch (err) {
      log.error("dependency resolution failed in startAll", { id, err: String(err) })
    }
  }

  const sorted = topologicalSort(directory, Array.from(allIds))
  const started: string[] = []

  for (const configId of sorted) {
    const proc = s.processes.get(configId)
    if (proc && (proc.status === "running" || proc.status === "starting")) continue
    await start(directory, configId, { portConflict: "pick-new" })
    started.push(s.configs.get(configId)?.name ?? configId)
  }

  if (started.length) {
    log.info("auto-started processes", { names: started })
  }
}

/**
 * Stop all running processes in reverse config order.
 */
export async function stopAll(directory: string): Promise<void> {
  const s = getState(directory)
  const configIds = Array.from(s.configs.keys()).reverse()
  for (const configId of configIds) {
    const proc = s.processes.get(configId)
    if (proc && (proc.status === "running" || proc.status === "starting" || proc.status === "restarting")) {
      await stop(directory, configId)
    }
  }
  await reconcileRuntime(directory, configIds)
  log.info("all processes stopped")
}

/**
 * Get a managed process by config ID.
 */
export function get(directory: string, configId: string): Process.ManagedProcess | undefined {
  return getState(directory).processes.get(configId)
}

/**
 * List all managed processes.
 */
export function list(directory: string): Process.ManagedProcess[] {
  return Array.from(getState(directory).processes.values())
}

/**
 * Get all loaded process configs.
 */
export function configs(directory: string): Process.ProcessConfig[] {
  return Array.from(getState(directory).configs.values())
}

/**
 * Apply restart policy after a process crash / command exit.
 */
function applyRestartPolicy(
  directory: string,
  configId: string,
  proc: Process.ManagedProcess,
  config: Process.ProcessConfig,
  exitCode: number,
): void {
  const shouldRestart = (() => {
    switch (config.restartPolicy) {
      case "always":
        return true
      case "on-failure":
        return exitCode !== 0
      case "never":
      default:
        return false
    }
  })()

  if (!shouldRestart || proc.restartCount >= config.maxRestarts) {
    if (proc.restartCount >= config.maxRestarts) {
      log.warn("max restarts reached", { configId, maxRestarts: config.maxRestarts })
    }
    return
  }

  const s = getState(directory)
  const delay = Math.min(1000 * Math.pow(2, proc.restartCount), 30000)
  proc.restartCount++
  proc.status = "restarting"
  s.processes.set(configId, proc)
  claxedoBus.publish({ type: "process.status", directory: real(directory), configId, status: "restarting" })

  log.info("scheduling restart", { configId, attempt: proc.restartCount, delay })
  setTimeout(async () => {
    const current = s.processes.get(configId)
    if (current?.status !== "restarting") return
    if (current.ptyId) {
      const ptyId = current.ptyId
      current.ptyId = undefined
      s.processes.set(configId, current)
      try {
        await Pty.remove(ptyId)
      } catch {}
    }
    start(directory, configId, { portConflict: "pick-new" })
  }, delay)
}

/**
 * Initialize the exit handler that monitors PTY exits and applies restart policies.
 * Returns an unsubscribe function.
 */
export function initExitHandler(directory: string): () => void {
  const unsub = claxedoBus.subscribe(async (event) => {
    if (event.type !== "pty.exited") return
    const { id: ptyId, exitCode, tail } = event
    const s = getState(directory)

    let matchedConfigId: string | undefined
    for (const [configId, proc] of s.processes) {
      if (proc.ptyId === ptyId) {
        matchedConfigId = configId
        break
      }
    }
    if (!matchedConfigId) return

    const configId = matchedConfigId
    const proc = s.processes.get(configId)!
    const config = s.configs.get(configId)
    const assignedPort = proc.assignedPort

    if (assignedPort !== undefined) {
      unregisterPort(assignedPort)
    }

    proc.exitCode = exitCode
    proc.exitedAt = Date.now()

    if (proc.status === "stopping") {
      proc.status = "stopped"
      proc.ptyId = undefined
      proc.assignedPort = undefined
      s.processes.set(configId, proc)
      claxedoBus.publish({ type: "process.stopped", directory: real(directory), configId, exitCode })
      claxedoBus.publish({ type: "process.status", directory: real(directory), configId, status: "stopped" })
      void reconcileRuntime(directory, [configId])
      return
    }

    proc.status = "crashed"
    proc.ptyId = undefined
    proc.assignedPort = undefined
    proc.conflict = await conflict(directory, tail, ptyId, assignedPort)
    s.processes.set(configId, proc)
    claxedoBus.publish({ type: "process.crashed", directory: real(directory), configId, exitCode, restartCount: proc.restartCount })
    claxedoBus.publish({ type: "process.status", directory: real(directory), configId, status: "crashed" })
    void reconcileRuntime(directory, [configId])

    if (!config) return
    applyRestartPolicy(directory, configId, proc, config, exitCode)
  })

  const unsubCommandExit = claxedoBus.subscribe(async (event) => {
    if (event.type !== "pty.stream") return
    const { id: ptyId, kind, exitCode, tail } = event
    if (kind === "data") {
      const s = getState(directory)

      let configId: string | undefined
      for (const [id, proc] of s.processes) {
        if (proc.ptyId === ptyId) {
          configId = id
          break
        }
      }
      if (!configId) return

      const proc = s.processes.get(configId)
      if (!proc || proc.status === "crashed") return

      const hit = await conflict(directory, tail, ptyId, proc.assignedPort)
      if (!hit) return

      proc.status = "crashed"
      proc.exitCode = proc.exitCode ?? 1
      proc.exitedAt = Date.now()
      proc.conflict = hit
      s.processes.set(configId, proc)
      claxedoBus.publish({ type: "process.crashed", directory: real(directory), configId, exitCode: proc.exitCode, restartCount: proc.restartCount, ptyId })
      claxedoBus.publish({ type: "process.status", directory: real(directory), configId, status: "crashed" })
      void reconcileRuntime(directory, [configId])
      return
    }
    if (kind !== "command-exit") return
    if (exitCode === undefined) return

    const s = getState(directory)

    let matchedConfigId: string | undefined
    for (const [configId, proc] of s.processes) {
      if (proc.ptyId === ptyId) {
        matchedConfigId = configId
        break
      }
    }
    if (!matchedConfigId) return

    const configId = matchedConfigId
    const proc = s.processes.get(configId)!

    if (proc.status !== "running") return

    if (proc.assignedPort !== undefined) {
      unregisterPort(proc.assignedPort)
    }

    const config = s.configs.get(configId)
    const currentPtyId = proc.ptyId
    const assignedPort = proc.assignedPort

    proc.exitCode = exitCode
    proc.exitedAt = Date.now()
    proc.status = "crashed"
    proc.assignedPort = undefined
    proc.conflict = await conflict(directory, tail, ptyId, assignedPort)
    s.processes.set(configId, proc)
    claxedoBus.publish({ type: "process.crashed", directory: real(directory), configId, exitCode, restartCount: proc.restartCount, commandExit: true, ptyId: currentPtyId })
    claxedoBus.publish({ type: "process.status", directory: real(directory), configId, status: "crashed" })
    log.info("inner command exited", { configId, ptyId, exitCode })
    void reconcileRuntime(directory, [configId])

    if (!config) return
    applyRestartPolicy(directory, configId, proc, config, exitCode)
  })

  getState(directory).dispose = () => {
    unsub()
    unsubCommandExit()
  }
  return () => {
    unsub()
    unsubCommandExit()
  }
}

/**
 * Dispose all state for a directory — stops processes and clears state.
 */
export async function dispose(directory: string): Promise<void> {
  const s = getState(directory)
  if (s.debounceTimer) clearTimeout(s.debounceTimer)
  try {
    s.watcher?.close()
  } catch {}
  const ids = Array.from(s.configs.keys())
  for (const configId of ids.toReversed()) {
    const proc = s.processes.get(configId)
    if (!proc || !proc.ptyId) continue
    if (!["running", "starting", "restarting", "stopping"].includes(proc.status)) continue
    await stop(directory, configId).catch(() => undefined)
  }
  await reconcileRuntime(directory, ids).catch(() => undefined)
  s.dispose?.()
  s.processes.clear()
  s.configs.clear()
  stateMap.delete(real(directory))
}

/**
 * Add a new process config and persist to disk.
 */
export async function addConfig(
  directory: string,
  input: Omit<Process.ProcessConfig, "id"> & { id?: string },
): Promise<Process.ProcessConfig> {
  const config = Process.ProcessConfig.parse({
    ...input,
    id: input.id || Process.createId(),
  })
  const s = getState(directory)
  s.configs.set(config.id, config)
  s.processes.set(config.id, idle(config.id))
  await saveConfig(directory, Array.from(s.configs.values()))
  return config
}

/**
 * Update an existing process config and persist to disk.
 */
export async function updateConfig(
  directory: string,
  id: string,
  updates: Partial<Omit<Process.ProcessConfig, "id">>,
): Promise<Process.ProcessConfig> {
  const s = getState(directory)
  const existing = s.configs.get(id)
  if (!existing) throw new Error(`Process config not found: ${id}`)
  const updated = Process.ProcessConfig.parse({ ...existing, ...updates, id })
  if (!samePort(existing.port, updated.port)) {
    await Lease.drop(key(directory, id))
  }
  s.configs.set(id, updated)
  await saveConfig(directory, Array.from(s.configs.values()))

  const proc = s.processes.get(id)
  if (proc && (proc.status === "running" || proc.status === "starting")) {
    await restart(directory, id)
  }

  return updated
}

/**
 * Remove a process config. Stops the process if running, then persists.
 */
export async function removeConfig(directory: string, id: string): Promise<void> {
  const s = getState(directory)
  if (!s.configs.has(id)) throw new Error(`Process config not found: ${id}`)
  const proc = s.processes.get(id)
  if (proc && (proc.status === "running" || proc.status === "starting" || proc.status === "restarting")) {
    await stop(directory, id)
  }
  await Lease.drop(key(directory, id))
  await reconcileRuntime(directory, [id])
  s.configs.delete(id)
  s.processes.delete(id)
  await saveConfig(directory, Array.from(s.configs.values()))
}

/**
 * Get a single process config by ID.
 */
export function getConfig(directory: string, id: string): Process.ProcessConfig | undefined {
  return getState(directory).configs.get(id)
}

// --- Exported helpers ---

export function findByName(directory: string, name: string): Process.ManagedProcess | undefined {
  const s = getState(directory)
  const lower = name.toLowerCase()
  for (const [configId, config] of s.configs) {
    if (config.name.toLowerCase() === lower) {
      return s.processes.get(configId)
    }
  }
  return undefined
}

/**
 * Find a managed process by its port name (from config.port.name).
 */
export function findByPortName(directory: string, name: string): { configId: string; config: Process.ProcessConfig; proc: Process.ManagedProcess } | undefined {
  const s = getState(directory)
  for (const [configId, config] of s.configs) {
    if (config.port?.name === name) {
      const proc = s.processes.get(configId)
      if (proc) return { configId, config, proc }
    }
  }
  return undefined
}

/**
 * Build a map of port name → assigned port for all running processes with portpick.
 */
export function portMap(directory: string): Record<string, number> {
  const s = getState(directory)
  const map: Record<string, number> = {}
  for (const [configId, config] of s.configs) {
    if (!config.port?.name) continue
    const proc = s.processes.get(configId)
    if (proc?.assignedPort !== undefined) {
      map[config.port.name] = proc.assignedPort
    }
  }
  return map
}

export function resolveProcess(directory: string, configIdOrPtyId: string): { configId: string; proc: Process.ManagedProcess | undefined } {
  const s = getState(directory)

  const proc = s.processes.get(configIdOrPtyId)
  if (proc) {
    return { configId: configIdOrPtyId, proc }
  }

  for (const [configId, p] of s.processes) {
    if (p.ptyId === configIdOrPtyId) {
      return { configId, proc: p }
    }
  }

  return { configId: configIdOrPtyId, proc: undefined }
}
