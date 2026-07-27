/**
 * Managed Process Manager (Claxedo)
 *
 * Manages long-running user-defined processes (dev servers, watchers, etc.)
 * backed by PTY sessions. Processes are declared in the project root
 * `.workspace-runtime/processes.jsonc` and support auto-start, restart policies,
 * deterministic workspace ports, and graceful shutdown.
 */

import { workspaceRuntimeBus } from "../bus"
import { Pty } from "../pty/index"
import { Log } from "../log"
import { parse as parseJsonc } from "jsonc-parser"
import path from "path"
import fs from "fs/promises"
import { realpathSync, watch, type FSWatcher } from "node:fs"
import z from "zod/v3"
import { zodToJsonSchema } from "zod-to-json-schema"
import { buildSafeEnv } from "../pty/env"
import { runGit } from "../git"
import * as PortLease from "./port-lease"
import { Process } from "./schema"
import { findFreePort, findPidOnPort, tryPort } from "./port-picker"
import type { ProcessObserver } from "./process-observer"

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
const globalPortReservations = new Map<number, string>()

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
  globalPortReservations.delete(port)
  globalPortRegistry.set(port, entry)
}

function unregisterPort(port: number): void {
  globalPortRegistry.delete(port)
  globalPortReservations.delete(port)
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
  startFlights: Map<string, Promise<Process.LaunchResult>>
  restartTimers: Map<string, ReturnType<typeof setTimeout>>
  watcher: FSWatcher | undefined
  debounceTimer: ReturnType<typeof setTimeout> | undefined
  initializing: Promise<void> | undefined
  initialized: boolean
  dispose: (() => void) | undefined
  disposed: boolean
}

const stateMap = new Map<string, State>()

interface WorkspaceBinding {
  id: string
  name?: string
}

const workspaceMap = new Map<string, WorkspaceBinding>()
const processObserverMap = new Map<string, ProcessObserver>()

function getState(directory: string): State {
  const key = real(directory)
  if (!stateMap.has(key)) {
    stateMap.set(key, {
      directory: key,
      configs: new Map(),
      processes: new Map(),
      startFlights: new Map(),
      restartTimers: new Map(),
      watcher: undefined,
      debounceTimer: undefined,
      initializing: undefined,
      initialized: false,
      dispose: undefined,
      disposed: false,
    })
    initExitHandler(key)
  }
  return stateMap.get(key)!
}

// --- Directory-scoped helpers --------------------------------------------------

function workspace(directory: string): string {
  return workspaceMap.get(real(directory))?.id ?? real(directory)
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

export function bindProcessObserver(directory: string, observer?: ProcessObserver) {
  const key = real(directory)
  if (observer) {
    processObserverMap.set(key, observer)
    return
  }
  processObserverMap.delete(key)
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

function portClaim(directory: string, processId: string) {
  const row = key(directory, processId)
  return `${row.project_id}\0${row.workspace}\0${row.process_id}`
}

function cfgPath(directory: string) {
  return path.join(real(directory), CONFIG_FILE)
}

function schemaPath(directory: string) {
  return path.join(real(directory), SCHEMA_FILE)
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
    namedUrl: undefined,
  }
}

function clearRestartTimer(s: State, configId: string) {
  const timer = s.restartTimers.get(configId)
  if (!timer) return
  clearTimeout(timer)
  s.restartTimers.delete(configId)
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
  await PortLease.prune({
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
      return (await runGit(["rev-parse", "--show-toplevel"], cwd)).trim()
    } catch {
      return cwd
    }
  } catch {
    return undefined
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

function addr(text: string) {
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

  log.warn("port-picker: killing existing process on preferred port", { port, pid })
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
      log.info("port-picker: reclaimed preferred port after kill", { port })
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
    log.warn("port-picker: failed to kill process on port", { port, pid, err: String(err) })
  }

  log.warn("port-picker: could not reclaim preferred port", { port })
  return false
}

function claimed(port: number, owner: string): boolean {
  const reservation = globalPortReservations.get(port)
  return globalPortRegistry.has(port) || (reservation !== undefined && reservation !== owner)
}

async function reservePort(port: number, owner: string): Promise<boolean> {
  if (claimed(port, owner)) return false
  if (!(await tryPort(port))) return false
  if (claimed(port, owner)) return false
  globalPortReservations.set(port, owner)
  return true
}

async function reserveFreePort(owner: string): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = await findFreePort()
    if (await reservePort(port, owner)) return port
  }
  return await reserveNextPort(1024, owner)
}

async function reserveNextPort(start: number, owner: string): Promise<number> {
  let port = Math.max(1, Math.floor(start))
  while (port <= 65535) {
    if (await reservePort(port, owner)) return port
    port += 1
  }
  throw new Error("No assignable port available")
}

function releasePort(port: number, owner: string): void {
  if (globalPortReservations.get(port) === owner) {
    globalPortReservations.delete(port)
  }
}

/**
 * Resolve a port for a process config.
 */
async function resolvePort(
  directory: string,
  config: Process.ProcessConfig,
  overrideStrategy?: Process.PortConflictStrategy,
): Promise<number | Process.PortConflictInfo> {
  const owner = portClaim(directory, config.id)
  if (!config.port) return await reserveFreePort(owner)

  const preferred = config.port.preferred
  if (preferred === undefined) return await reserveFreePort(owner)

  const hit = await PortLease.read(key(directory, config.id))
  const start =
    hit && hit.port_name === config.port.name && hit.preferred === preferred
      ? hit.port
      : preferred

  if (await reservePort(start, owner)) {
    log.info("port-picker: using preferred port", {
      name: config.port.name,
      port: start,
      preferred,
      workspace: title(directory),
    })
    return start
  }

  const strategy = overrideStrategy ?? config.port.onConflict

  if (!strategy) {
    log.info("port-picker: preferred port occupied, prompting user", {
      name: config.port.name,
      preferred: start,
    })
    return await getPortOccupier(directory, start)
  }

  if (strategy === "kill-existing") {
    const reclaimed = await killAndReclaimPort(start)
    if (reclaimed && await reservePort(start, owner)) return start
  } else {
    log.info("port-picker: preferred port occupied, picking new", {
      name: config.port.name,
      preferred: start,
    })
  }

  return await reserveNextPort(start + 1, owner)
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

const CONFIG_FILE = ".workspace-runtime/processes.jsonc"
const SCHEMA_FILE = ".workspace-runtime/processes.schema.json"
// Legacy paths kept for one-shot migration on first load.
const LEGACY_CONFIG_FILES = [".claxedo/processes.jsonc", ".opencode/processes.jsonc"]

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
    await fs.mkdir(path.dirname(schemaPath(directory)), { recursive: true })
    await fs.writeFile(schemaPath(directory), JSON.stringify(raw, null, 2) + "\n", "utf-8")
  } catch (err) {
    log.warn("failed to write process schema", { err: String(err) })
  }
}

/**
 * Load process configs from the project root `.workspace-runtime/processes.jsonc`.
 *
 * If the new path doesn't exist but a legacy `.claxedo/processes.jsonc` or
 * `.opencode/processes.jsonc` does, migrate it (parse + rewrite at the new
 * path with generated ids) and continue. The legacy file is left in place so
 * external tooling that still reads it doesn't break.
 */
export async function loadConfig(directory: string): Promise<Process.ProcessConfig[]> {
  const filePath = cfgPath(directory)

  // Migrate legacy process config into the neutral runtime path when only a
  // legacy file exists.
  let migrated = false
  try {
    await fs.access(filePath)
  } catch {
    for (const legacyConfigFile of LEGACY_CONFIG_FILES) {
      const legacyPath = path.join(real(directory), legacyConfigFile)
      try {
        const legacyContent = await fs.readFile(legacyPath, "utf-8")
        const legacyRaw = parseJsonc(legacyContent)
        const legacyParsed = Process.ProcessConfigFile.parse(legacyRaw)
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        await fs.writeFile(
          filePath,
          JSON.stringify({ processes: legacyParsed.processes }, null, 2) + "\n",
          "utf-8",
        )
        migrated = true
        log.info("migrated legacy process config", { from: legacyPath, to: filePath })
        break
      } catch (err) {
        // No legacy file at this path — try the next candidate.
        void err
      }
    }
  }
  void migrated
  try {
    const content = await fs.readFile(filePath, "utf-8")
    const raw = parseJsonc(content)
    const parsed = Process.ProcessConfigFile.parse(raw)
    const s = getState(directory)
    s.configs.clear()
    for (const config of parsed.processes) {
      s.configs.set(config.id, config)
    }
    await mirror(directory, parsed.processes)
    log.info("loaded process configs", { count: parsed.processes.length })
    void writeSchema(directory)
    return parsed.processes
  } catch (err) {
    if (code(err) === "ENOENT") {
      log.info("no process config file found", { path: filePath })
      const s = getState(directory)
      s.configs.clear()
      s.processes.clear()
      await PortLease.prune({
        project_id: real(directory),
        workspace: workspace(directory),
        process_ids: new Set(),
      })
      return []
    }
    log.error("failed to load process config", { path: filePath, err: String(err) })
    return []
  }
}

/**
 * Write process configs to `.workspace-runtime/processes.jsonc`.
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

  workspaceRuntimeBus.publish({ type: "process.config.changed", directory: real(directory), configs })
  log.info("saved process configs", { count: configs.length })
  if (s.initialized && !s.watcher) watchConfig(directory)
}

/**
 * Initialize config state and its watcher once for a workspace.
 */
export async function initialize(directory: string): Promise<void> {
  const s = getState(directory)
  if (s.initialized) return
  if (s.initializing) return s.initializing

  s.initializing = (async () => {
    await loadConfig(directory)
    watchConfig(directory)
    s.initialized = true
  })()

  try {
    await s.initializing
  } finally {
    s.initializing = undefined
  }
}

/**
 * Watch the project root `.workspace-runtime/processes.jsonc` for changes.
 */
export function watchConfig(directory: string): void {
  const s = getState(directory)

  if (s.watcher) return

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
      await PortLease.prune({
        project_id: real(directory),
        workspace: workspace(directory),
        process_ids: new Set(),
      })
      workspaceRuntimeBus.publish({ type: "process.config.changed", directory: real(directory), configs: [] })
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
      await PortLease.drop(key(directory, id))
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
          await PortLease.drop(key(directory, id))
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
  workspaceRuntimeBus.publish({ type: "process.config.changed", directory: real(directory), configs: newConfigs })
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
    const unsub = workspaceRuntimeBus.subscribe((event) => {
      if (event.type !== "pty.exited") return
      if (event.id !== ptyId) return
      clearTimeout(timer)
      unsub()
      resolve(true)
    })
  })
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
    workspaceRuntimeBus.publish({ type: "process.stopped", directory: real(directory), configId, exitCode: next.exitCode ?? 0 })
  }
  if (prev.status !== status || prev.ptyId !== next.ptyId || prev.assignedPort !== next.assignedPort) {
    workspaceRuntimeBus.publish({ type: "process.status", directory: real(directory), configId, status })
  }
}

export async function reconcileRuntime(directory: string, ids?: string[]): Promise<void> {
  const s = getState(directory)
  const pick = ids ?? Array.from(s.configs.keys())
  if (pick.length === 0) return

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
  if (s.disposed) return fail(`Workspace process manager is disposed: ${real(directory)}`)
  const existingFlight = s.startFlights.get(configId)
  if (existingFlight) return await existingFlight

  const flight = startOnce(directory, configId, opts).finally(() => {
    s.startFlights.delete(configId)
  })
  s.startFlights.set(configId, flight)
  return await flight
}

async function startOnce(
  directory: string,
  configId: string,
  opts?: { portConflict?: Process.PortConflictStrategy; routeConflict?: Process.PortConflictStrategy },
): Promise<Process.LaunchResult> {
  const s = getState(directory)
  if (s.disposed) return fail(`Workspace process manager is disposed: ${real(directory)}`)
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
  const assignedPortOwner = portClaim(directory, configId)
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
      workspaceRuntimeBus.publish({ type: "process.status", directory: real(directory), configId, status: "crashed" })
      return {
        kind: "port_conflict",
        conflict: portResult,
      }
    }
    assignedPort = portResult
    log.info("port-picker: assigned port", { configId, name: config.port.name, port: assignedPort })
  }

  const pm = portMap(directory)
  if (config.port && assignedPort !== undefined) {
    pm[config.port.name] = assignedPort
  }

  const env: Record<string, string> = {
    ...buildSafeEnv(process.env, { customPrefix: "CLAXEDO" }),
    // Operator-configured process env: explicit (see SafeEnvSource).
    ...buildSafeEnv(resolvePortTemplates(config.env || {}, pm), { customPrefix: "CLAXEDO", source: "explicit" }),
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
  workspaceRuntimeBus.publish({ type: "process.status", directory: real(directory), configId, status: "starting" })

  let ptyId: string | undefined
  let registeredPort = false
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
        Object.assign(env, buildSafeEnv({ [config.port.inject]: String(assignedPort) }, { customPrefix: "CLAXEDO", source: "explicit" }))
      }
    }

    const processObserver = processObserverMap.get(real(directory))
    const info = await Pty.create(
      {
        command: shell,
        args: [],
        cwd,
        title: config.name,
        initialCommand: fullCommand + "; printf '\\033]777;process-exit;%d\\007' $?",
        env,
        managed: true,
      },
      processObserver
        ? {
            observer: processObserver,
            kind: "managed-process",
            ownerId: `managed-process:${crypto.randomUUID()}`,
            workspaceId: workspace(directory),
            directory: real(directory),
            label: config.name,
            operations: {
              stopGracefully: async () => stop(directory, configId),
              killOwnedTree: async () => stop(directory, configId, "SIGKILL"),
            },
          }
        : undefined,
    )
    ptyId = info.id

    if (s.disposed) {
      try {
        await Pty.remove(info.id)
      } catch {}
      if (assignedPort !== undefined) releasePort(assignedPort, assignedPortOwner)
      return fail(`Workspace process manager disposed during start: ${real(directory)}`)
    }

    proc.ptyId = info.id
    proc.status = "running"
    s.processes.set(configId, proc)

    if (assignedPort !== undefined) {
      registerPort(assignedPort, {
        processName: config.name,
        processId: configId,
        directory: workspace(directory),
        workspace: title(directory),
      })
      registeredPort = true
    }
    if (config.port?.preferred !== undefined && assignedPort !== undefined) {
      await PortLease.write({
        ...key(directory, config.id),
        port_name: config.port.name,
        preferred: config.port.preferred,
        port: assignedPort,
      })
    }

    workspaceRuntimeBus.publish({ type: "process.started", directory: real(directory), configId, ptyId: info.id })
    workspaceRuntimeBus.publish({ type: "process.status", directory: real(directory), configId, status: "running" })
    log.info("process started", { configId, name: config.name, ptyId: info.id, port: assignedPort })

    return {
      kind: "started",
      process: proc,
    }
  } catch (err) {
    if (assignedPort !== undefined) {
      if (registeredPort) {
        unregisterPort(assignedPort)
      } else {
        releasePort(assignedPort, assignedPortOwner)
      }
    }
    if (ptyId) {
      try {
        await Pty.remove(ptyId)
      } catch {}
    }
    proc.status = "crashed"
    proc.ptyId = undefined
    proc.assignedPort = undefined
    proc.exitedAt = Date.now()
    s.processes.set(configId, proc)
    workspaceRuntimeBus.publish({ type: "process.status", directory: real(directory), configId, status: "crashed" })
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
  clearRestartTimer(s, configId)
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
  workspaceRuntimeBus.publish({ type: "process.status", directory: real(directory), configId, status: "stopping" })

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
  clearRestartTimer(s, configId)
  workspaceRuntimeBus.publish({ type: "process.status", directory: real(directory), configId, status: "restarting" })

  log.info("scheduling restart", { configId, attempt: proc.restartCount, delay })
  const timer = setTimeout(async () => {
    s.restartTimers.delete(configId)
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
  s.restartTimers.set(configId, timer)
}

/**
 * Initialize the exit handler that monitors PTY exits and applies restart policies.
 * Returns an unsubscribe function.
 */
function initExitHandler(directory: string): () => void {
  const unsub = workspaceRuntimeBus.subscribe(async (event) => {
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
      workspaceRuntimeBus.publish({ type: "process.stopped", directory: real(directory), configId, exitCode })
      workspaceRuntimeBus.publish({ type: "process.status", directory: real(directory), configId, status: "stopped" })
      void reconcileRuntime(directory, [configId])
      return
    }

    proc.status = "crashed"
    proc.ptyId = undefined
    proc.assignedPort = undefined
    proc.conflict = await conflict(directory, tail, ptyId, assignedPort)
    s.processes.set(configId, proc)
    workspaceRuntimeBus.publish({ type: "process.crashed", directory: real(directory), configId, exitCode, restartCount: proc.restartCount })
    workspaceRuntimeBus.publish({ type: "process.status", directory: real(directory), configId, status: "crashed" })
    void reconcileRuntime(directory, [configId])

    if (!config) return
    applyRestartPolicy(directory, configId, proc, config, exitCode)
  })

  const unsubCommandExit = workspaceRuntimeBus.subscribe(async (event) => {
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
      workspaceRuntimeBus.publish({ type: "process.crashed", directory: real(directory), configId, exitCode: proc.exitCode, restartCount: proc.restartCount, ptyId })
      workspaceRuntimeBus.publish({ type: "process.status", directory: real(directory), configId, status: "crashed" })
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
    workspaceRuntimeBus.publish({ type: "process.crashed", directory: real(directory), configId, exitCode, restartCount: proc.restartCount, commandExit: true, ptyId: currentPtyId })
    workspaceRuntimeBus.publish({ type: "process.status", directory: real(directory), configId, status: "crashed" })
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
  s.disposed = true
  if (s.debounceTimer) clearTimeout(s.debounceTimer)
  for (const configId of Array.from(s.restartTimers.keys())) {
    clearRestartTimer(s, configId)
  }
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
  processObserverMap.delete(real(directory))
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
    await PortLease.drop(key(directory, id))
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
  await PortLease.drop(key(directory, id))
  await reconcileRuntime(directory, [id])
  s.configs.delete(id)
  s.processes.delete(id)
  await saveConfig(directory, Array.from(s.configs.values()))
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
 * Build a map of port name → assigned port for all running processes with port-picker.
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

function resolveProcess(directory: string, configIdOrPtyId: string): { configId: string; proc: Process.ManagedProcess | undefined } {
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
