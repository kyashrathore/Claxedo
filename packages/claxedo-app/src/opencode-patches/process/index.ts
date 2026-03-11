/**
 * Process Manager (Claxedo)
 *
 * Manages long-running user-defined processes (dev servers, watchers, etc.)
 * backed by PTY sessions. Processes are declared in the project root
 * `.opencode/processes.jsonc` and support auto-start, restart policies,
 * deterministic workspace ports, and graceful shutdown.
 */

import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Pty } from "@/pty"
import { Log } from "@/util/log"
import { parse as parseJsonc } from "jsonc-parser"
import path from "path"
import fs from "fs/promises"
import { realpathSync, watch, type FSWatcher } from "node:fs"
import z from "zod"
import { buildSafeEnv } from "../pty/env"
import { collectDiagnostics } from "./diagnostics"
import * as Lease from "./lease"
import { Process } from "./process"
import { findFreePort, findNextPort, findPidOnPort, tryPort } from "./portpick"

// -- Global port registry (cross-workspace, outside Instance.state scope) -----
// Maps assigned port → workspace info so port conflict detection can tell the
// user which workspace/process occupies a port, even across workspaces.

interface PortRegistryEntry {
  processName: string
  processId: string
  directory: string
  workspace: string
}

const globalPortRegistry = new Map<number, PortRegistryEntry>()

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

function root() {
  if (Instance.project.id === "global" || Instance.project.worktree === "/") {
    return real(Instance.directory)
  }
  return real(Instance.project.worktree)
}

function workspace() {
  return real(Instance.directory)
}

function title() {
  if (workspace() === root()) return "main"
  return path.basename(workspace()) || workspace()
}

function offset() {
  if (workspace() === root()) return 0
  const dirs = new Set<string>([workspace()])
  for (const dir of Instance.project.sandboxes) {
    dirs.add(real(dir))
  }
  dirs.delete(root())
  const list = Array.from(dirs).sort((a, b) => a.localeCompare(b))
  const idx = list.indexOf(workspace())
  return idx === -1 ? 1 : idx + 1
}

function key(processId: string) {
  return {
    project_id: Instance.project.id,
    workspace: workspace(),
    process_id: processId,
  }
}

function cfgPath() {
  return path.join(root(), CONFIG_FILE)
}

function schemaPath() {
  return path.join(root(), SCHEMA_FILE)
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
  }
}

async function mirror(configs: Process.ProcessConfig[]) {
  const s = state()
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
    project_id: Instance.project.id,
    workspace: workspace(),
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
    // Get the process's working directory
    const cwd = process.platform === "darwin"
      ? execSync(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null | grep ^n | cut -c2-`, { encoding: "utf-8", timeout: 5000 }).trim()
      : execSync(`readlink /proc/${pid}/cwd 2>/dev/null`, { encoding: "utf-8", timeout: 5000 }).trim()
    if (!cwd) return undefined
    // Resolve to git worktree root
    try {
      return execSync(`git -C ${JSON.stringify(cwd)} rev-parse --show-toplevel 2>/dev/null`, { encoding: "utf-8", timeout: 5000 }).trim()
    } catch {
      // Not a git repo — return the raw cwd
      return cwd
    }
  } catch {
    return undefined
  }
}

/**
 * Get detailed info about what's occupying a port.
 * Checks the global port registry first (cross-workspace), then falls back
 * to PID-level detection. Detects the workspace from the process's worktree.
 */
async function getPortOccupier(port: number): Promise<Process.PortConflictInfo> {
  const info: Process.PortConflictInfo = { type: "port-conflict", port }

  // Check global registry first — covers all workspaces
  const registered = globalPortRegistry.get(port)
  if (registered) {
    info.processName = registered.processName
    info.processId = registered.processId
    info.directory = registered.directory
  }

  const pid = await findPidOnPort(port)
  if (!pid) return info
  info.pid = pid

  // Get command name
  try {
    const { execSync } = await import("child_process")
    info.command = execSync(`ps -p ${pid} -o command=`, { encoding: "utf-8", timeout: 5000 }).trim()
  } catch {}

  // Detect workspace from the process's worktree
  info.directory = info.directory ?? await detectWorktreeForPid(pid)

  // If registry didn't match, check current workspace's managed processes
  if (!info.processName) {
    const s = state()
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

/**
 * Kill the process occupying a preferred port and reclaim it.
 * Returns true if the port was successfully reclaimed.
 */
async function killAndReclaimPort(port: number): Promise<boolean> {
  const pid = await findPidOnPort(port)
  if (!pid) {
    // Port may have been freed in the meantime
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
    // SIGKILL as fallback
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
 * Resolve a port for a process config, handling preferred port and conflict strategy.
 *
 * @param config  Process config
 * @param overrideStrategy  Explicit strategy from the caller (e.g. user chose in dialog).
 *                          Takes precedence over config.port.onConflict.
 * @returns  Assigned port number, or PortConflictInfo if the caller should prompt the user.
 */
async function resolvePort(
  config: Process.ProcessConfig,
  overrideStrategy?: Process.PortConflictStrategy,
): Promise<number | Process.PortConflictInfo> {
  if (!config.port) return await findFreePort()

  const preferred = config.port.preferred
  if (preferred === undefined) return await findFreePort()

  const hit = await Lease.read(key(config.id))
  const start =
    hit && hit.port_name === config.port.name && hit.preferred === preferred
      ? hit.port
      : preferred + offset()

  // Try the workspace-targeted port first
  if (await tryPort(start)) {
    log.info("portpick: using preferred port", {
      name: config.port.name,
      port: start,
      preferred,
      workspace: title(),
    })
    return start
  }

  // Port is occupied — determine strategy
  const strategy = overrideStrategy ?? config.port.onConflict

  if (!strategy) {
    // No strategy set — return conflict info for interactive resolution
    log.info("portpick: preferred port occupied, prompting user", {
      name: config.port.name,
      preferred: start,
    })
    return await getPortOccupier(start)
  }

  if (strategy === "kill-existing") {
    const reclaimed = await killAndReclaimPort(start)
    if (reclaimed) return start
    // Fall through to pick-new if kill failed
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
  for (const [key, value] of Object.entries(env)) {
    result[key] = value.replace(/\{\{port:([a-zA-Z0-9._-]+)\}\}/g, (_match, name) => {
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
      names.add(m[1])
    }
  }
  return Array.from(names)
}

function isFlag(inject: string): boolean {
  return inject.startsWith("-")
}

export { Process, configChanged }

const log = Log.create({ service: "process" })

const CONFIG_FILE = ".opencode/processes.jsonc"
const SCHEMA_FILE = ".opencode/processes.schema.json"

/**
 * Write the JSON Schema for processes.jsonc so editors provide autocompletion.
 * Uses Zod v4's built-in `z.toJSONSchema()`.
 */
async function writeSchema(): Promise<void> {
  try {
    const raw = z.toJSONSchema(Process.ProcessConfigFile)
    // Clean up: remove runtime-generated default for `id` since each process
    // gets a unique ID — showing a stale default in the schema is misleading.
    const items = (raw as any)?.properties?.processes?.items
    if (items?.properties?.id?.default) {
      delete items.properties.id.default
    }
    // Mark fields with defaults as not required for better editor UX
    if (items?.required && items?.properties) {
      items.required = items.required.filter((field: string) => {
        return !items.properties[field]?.default && items.properties[field]?.default !== false
      })
    }
    await fs.mkdir(path.dirname(schemaPath()), { recursive: true })
    await fs.writeFile(schemaPath(), JSON.stringify(raw, null, 2) + "\n", "utf-8")
  } catch (err) {
    log.warn("failed to write process schema", { err: String(err) })
  }
}

interface State {
  configs: Map<string, Process.ProcessConfig>
  processes: Map<string, Process.ManagedProcess>
  watcher: FSWatcher | undefined
  debounceTimer: ReturnType<typeof setTimeout> | undefined
  dispose: (() => void) | undefined
}

const state = Instance.state<State>(
  () => ({
    configs: new Map(),
    processes: new Map(),
    watcher: undefined,
    debounceTimer: undefined,
    dispose: undefined,
  }),
  async (s) => {
    if (s.debounceTimer) clearTimeout(s.debounceTimer)
    try {
      s.watcher?.close()
    } catch {}
    const ids = Array.from(s.configs.keys())
    for (const configId of ids.toReversed()) {
      const proc = s.processes.get(configId)
      if (!proc || !proc.ptyId) continue
      if (!["running", "starting", "restarting", "stopping"].includes(proc.status)) continue
      await stop(configId).catch(() => undefined)
    }
    await reconcileRuntime(ids).catch(() => undefined)
    s.dispose?.()
    s.processes.clear()
    s.configs.clear()
  },
)

/**
 * Load process configs from the project root `.opencode/processes.jsonc`.
 * Returns the parsed configs or an empty array on error.
 */
export async function loadConfig(): Promise<Process.ProcessConfig[]> {
  const filePath = cfgPath()
  try {
    const content = await fs.readFile(filePath, "utf-8")
    const raw = parseJsonc(content)
    const parsed = Process.ProcessConfigFile.parse(raw)
    const s = state()
    s.configs.clear()
    for (const config of parsed.processes) {
      s.configs.set(config.id, config)
    }
    await mirror(parsed.processes)
    log.info("loaded process configs", { count: parsed.processes.length })
    // Write schema file alongside config for editor autocompletion
    void writeSchema()
    return parsed.processes
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      log.info("no process config file found", { path: filePath })
      const s = state()
      s.configs.clear()
      s.processes.clear()
      await Lease.prune({
        project_id: Instance.project.id,
        workspace: workspace(),
        process_ids: new Set(),
      })
      return []
    }
    log.error("failed to load process config", { path: filePath, err: String(err) })
    return []
  }
}


/**
 * Write process configs to `.opencode/processes.jsonc`.
 */
export async function saveConfig(configs: Process.ProcessConfig[]): Promise<void> {
  const filePath = cfgPath()
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })

  const file: Process.ProcessConfigFile = {
    $schema: "./processes.schema.json",
    processes: configs,
  }
  await fs.writeFile(filePath, JSON.stringify(file, null, 2) + "\n", "utf-8")
  // Write schema file alongside config for editor autocompletion
  void writeSchema()

  const s = state()
  s.configs.clear()
  for (const config of configs) {
    s.configs.set(config.id, config)
  }
  await mirror(configs)

  Bus.publish(Process.Event.ConfigChanged, { configs })
  log.info("saved process configs", { count: configs.length })
}

/**
 * Watch the project root `.opencode/processes.jsonc` for changes.
 * Watches the `.opencode` directory (not the file directly) to handle
 * file creation, modification, and deletion. Debounces 100ms.
 */
export function watchConfig(): void {
  const s = state()

  // Close any existing watcher
  if (s.watcher) {
    try {
      s.watcher.close()
    } catch {}
    s.watcher = undefined
  }

  const dirPath = path.dirname(cfgPath())
  const filename = path.basename(cfgPath())

  try {
    const watcher = watch(dirPath, (eventType, changedFile) => {
      if (changedFile !== filename) return

      // Debounce 100ms to handle editors that write temp files
      if (s.debounceTimer) clearTimeout(s.debounceTimer)
      s.debounceTimer = setTimeout(() => {
        s.debounceTimer = undefined
        reconcileFromDisk()
      }, 100)
    })

    watcher.on("error", (err) => {
      log.warn("config watcher error", { err: String(err) })
    })

    s.watcher = watcher
    log.info("watching config file", { path: cfgPath() })
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      // Directory doesn't exist yet, that's fine — no configs to watch
      log.info("config directory does not exist, skipping watcher", { dir: dirPath })
      return
    }
    log.error("failed to start config watcher", { err: String(err) })
  }
}

/**
 * Re-read the config file from disk and reconcile with current state.
 * Handles added/removed/changed configs and file deletion.
 */
async function reconcileFromDisk(): Promise<void> {
  const s = state()
  const filePath = cfgPath()

  let newConfigs: Process.ProcessConfig[]

  try {
    const content = await fs.readFile(filePath, "utf-8")
    const raw = parseJsonc(content)
    const parsed = Process.ProcessConfigFile.safeParse(raw)

    if (!parsed.success) {
      // Parse error — keep current configs, log the error
      log.warn("config parse error on file change, keeping current configs", {
        path: filePath,
        error: String(parsed.error),
      })
      return
    }

    newConfigs = parsed.data.processes
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      // File deleted — stop all and clear
      log.info("config file deleted, stopping all processes")
      await stopAll()
      s.configs.clear()
      s.processes.clear()
      await Lease.prune({
        project_id: Instance.project.id,
        workspace: workspace(),
        process_ids: new Set(),
      })
      Bus.publish(Process.Event.ConfigChanged, { configs: [] })
      return
    }
    log.error("failed to read config on change", { path: filePath, err: String(err) })
    return
  }

  // Diff old configs vs new configs by id
  const oldIds = new Set(s.configs.keys())
  const newById = new Map(newConfigs.map((c) => [c.id, c]))
  const newIds = new Set(newById.keys())

  // Removed configs: stop running instances, remove from state
  for (const id of oldIds) {
    if (!newIds.has(id)) {
      const proc = s.processes.get(id)
      if (proc && (proc.status === "running" || proc.status === "starting" || proc.status === "restarting")) {
        await stop(id)
      }
      await Lease.drop(key(id))
      s.configs.delete(id)
      s.processes.delete(id)
      log.info("config removed", { id })
    }
  }

  // Added configs: store with idle status
  for (const [id, config] of newById) {
    if (!oldIds.has(id)) {
      s.configs.set(id, config)
      s.processes.set(id, idle(id))
      log.info("config added", { id, name: config.name })
    }
  }

  // Changed configs: update config and restart if running
  for (const [id, newConfig] of newById) {
    if (oldIds.has(id)) {
      const oldConfig = s.configs.get(id)!
      if (configChanged(oldConfig, newConfig)) {
        if (!samePort(oldConfig.port, newConfig.port)) {
          await Lease.drop(key(id))
        }
        s.configs.set(id, newConfig)
        const proc = s.processes.get(id)
        if (proc && (proc.status === "running" || proc.status === "starting" || proc.status === "restarting")) {
          log.info("config changed, restarting process", { id, name: newConfig.name })
          await restart(id)
        } else {
          log.info("config changed", { id, name: newConfig.name })
        }
      } else {
        // Config unchanged but still update the reference
        s.configs.set(id, newConfig)
      }
    }
  }

  await mirror(newConfigs)
  Bus.publish(Process.Event.ConfigChanged, { configs: newConfigs })
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
  const ap = a.port
  const bp = b.port
  return !samePort(ap, bp)
}

/**
 * Resolve the ordered list of config IDs that must be started before this one.
 * Combines explicit `dependsOn` names with implicit port template dependencies.
 * Detects cycles and throws on circular dependencies.
 */
function deps(configId: string, pick?: Set<string>): string[] {
  const s = state()
  const config = s.configs.get(configId)
  if (!config) return []

  const depIds = new Set<string>()

  if (config.dependsOn) {
    for (const depName of config.dependsOn) {
      const found = findConfigByName(depName)
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

function resolveDependencyOrder(configId: string): string[] {
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
    for (const depId of deps(id)) {
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
function findConfigByName(name: string): Process.ProcessConfig | undefined {
  const s = state()
  const lower = name.toLowerCase()
  for (const config of s.configs.values()) {
    if (config.name.toLowerCase() === lower) return config
  }
  return undefined
}

async function ready(configId: string, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const s = state()
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
  return {
    kind: "not_found",
    error,
  }
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
    const unsub = Bus.subscribe(Pty.Event.Exited, (event) => {
      if (event.properties.id !== ptyId) return
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

function scrub(configId: string, nextStatus?: Process.Status) {
  const s = state()
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
  }
  s.processes.set(configId, next)

  if (status === "stopped" && prev.status !== "stopped") {
    Bus.publish(Process.Event.Stopped, { configId, exitCode: next.exitCode ?? 0 })
  }
  if (prev.status !== status || prev.ptyId !== next.ptyId || prev.assignedPort !== next.assignedPort) {
    Bus.publish(Process.Event.Status, { configId, status })
  }
}

export async function reconcileRuntime(ids?: string[]): Promise<void> {
  const s = state()
  const pick = ids ?? Array.from(s.configs.keys())
  if (pick.length === 0) return

  const snap = await collectDiagnostics({
    directory: workspace(),
    configs: configs(),
    processes: list(),
    ptys: Pty.listDetailed(),
  }).catch(() => undefined)

  if (snap) {
    const rows = snap.os.filter((row) => {
      return row.process_id !== undefined && pick.includes(row.process_id) && row.workspace_id === workspace()
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
      scrub(configId, "stopped")
      continue
    }
    if (!info && proc.assignedPort !== undefined) {
      scrub(configId, proc.status)
    }
  }
}

/**
 * Start a process by config ID.
 * Auto-starts any dependencies (explicit `dependsOn` or inferred from `{{port:name}}` templates).
 *
 * @param configId  The process config ID to start.
 * @param opts.portConflict  Explicit port conflict resolution strategy.
 *   If the preferred port is occupied and this is not set (and config.port.onConflict is not set),
 *   returns a PortConflictInfo instead of a ManagedProcess.
 */
export async function start(
  configId: string,
  opts?: { portConflict?: Process.PortConflictStrategy },
): Promise<Process.LaunchResult> {
  const s = state()
  const config = s.configs.get(configId)
  if (!config) {
    log.error("config not found", { configId })
    return miss()
  }

  // Check if already running
  const existing = s.processes.get(configId)
  if (existing && (existing.status === "running" || existing.status === "starting")) {
    log.info("process already running", { configId, status: existing.status })
    return {
      kind: "already_running",
      process: existing,
    }
  }

  // --- Auto-start dependencies ---
  try {
    const depOrder = resolveDependencyOrder(configId)
    for (const depId of depOrder) {
      const depProc = s.processes.get(depId)
      if (depProc && (depProc.status === "running" || depProc.status === "starting")) continue
      const depConfig = s.configs.get(depId)
      log.info("auto-starting dependency", { configId, dependency: depConfig?.name ?? depId })
      const started = await start(depId, { portConflict: "pick-new" })
      if (started.kind !== "started" && started.kind !== "already_running") {
        log.error("dependency failed to start", {
          configId,
          dependency: depConfig?.name ?? depId,
          kind: started.kind,
          error: "error" in started ? started.error : undefined,
        })
        return fail(`Dependency failed to start: ${depConfig?.name ?? depId}`)
      }
      if (!(await ready(depId))) {
        log.error("dependency did not become ready", { configId, dependency: depConfig?.name ?? depId })
        return fail(`Dependency did not become ready: ${depConfig?.name ?? depId}`)
      }
    }
  } catch (err) {
    log.error("dependency resolution failed", { configId, err: String(err) })
    return fail(`Dependency resolution failed: ${String(err)}`)
  }

  const cwd = config.cwd ? path.resolve(Instance.directory, config.cwd) : Instance.directory

  // --- Port assignment (with preferred port + conflict resolution) ---
  let assignedPort: number | undefined
  if (config.port) {
    const portResult = await resolvePort(config, opts?.portConflict)
    if (typeof portResult === "object") {
      return {
        kind: "port_conflict",
        conflict: portResult,
      }
    }
    assignedPort = portResult
    log.info("portpick: assigned port", { configId, name: config.port.name, port: assignedPort })
  }

  // Build port map from all running processes + this one
  const pm = portMap()
  if (config.port && assignedPort !== undefined) {
    pm[config.port.name] = assignedPort
  }

  const env: Record<string, string> = {
    ...buildSafeEnv(process.env, { customPrefix: "CLAXEDO" }),
    ...resolvePortTemplates(config.env || {}, pm),
    OPENCODE_TERMINAL: "1",
    OPENCODE_PROCESS: config.name,
    OPENCODE_PROCESS_ID: configId,
    CLAXEDO_WORKSPACE_ID: workspace(),
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
  }
  s.processes.set(configId, proc)
  Bus.publish(Process.Event.Status, { configId, status: "starting" })

  try {
    const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh")
    let fullCommand = config.args?.length
      ? [config.command, ...config.args].join(" ")
      : config.command

    // Inject port via flag or env var
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

    await new Promise((r) => setTimeout(r, 250))
    try {
      Pty.write(info.id, fullCommand + "; printf '\\033]777;process-exit;%d\\007' $?\n")
    } catch (e) {
      log.warn("failed to write command to process shell", { configId, ptyId: info.id, err: String(e) })
    }

    // Register port in global cross-workspace registry
    if (assignedPort !== undefined) {
      registerPort(assignedPort, {
        processName: config.name,
        processId: configId,
        directory: workspace(),
        workspace: title(),
      })
    }
    if (config.port?.preferred !== undefined && assignedPort !== undefined) {
      await Lease.write({
        ...key(config.id),
        port_name: config.port.name,
        preferred: config.port.preferred,
        port: assignedPort,
      })
    }

    Bus.publish(Process.Event.Started, { configId, ptyId: info.id })
    Bus.publish(Process.Event.Status, { configId, status: "running" })
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
    Bus.publish(Process.Event.Status, { configId, status: "crashed" })
    log.error("failed to start process", { configId, err: String(err) })
    return fail(`Failed to start process: ${String(err)}`, proc)
  }
}

/**
 * Stop a process by config ID or pty ID.
 * Sends Ctrl-C first, then escalates to PTY removal and process-group SIGKILL.
 */
export async function stop(configIdOrPtyId: string, signal?: string): Promise<void> {
  const s = state()
  const { configId, proc } = resolveProcess(configIdOrPtyId)
  if (!proc) {
    log.info("no running process to stop", { id: configIdOrPtyId })
    return
  }
  if (!proc.ptyId) {
    scrub(configId, proc.status === "crashed" ? "crashed" : "stopped")
    await reconcileRuntime([configId])
    return
  }

  // Unregister port from global registry
  if (proc.assignedPort !== undefined) {
    unregisterPort(proc.assignedPort)
  }

  // IMPORTANT: Set status to "stopping" BEFORE calling Pty.remove().
  // The initExitHandler subscribes to Pty.Event.Exited and checks
  // proc.status === "stopping" to distinguish user-initiated stops
  // from crashes. If this ordering is violated, the exit handler
  // would incorrectly treat the exit as a crash and apply restart policies.
  const updated: Process.ManagedProcess = { ...proc, status: "stopping" }
  s.processes.set(configId, updated)
  Bus.publish(Process.Event.Status, { configId, status: "stopping" })

  const ptyId = proc.ptyId

  // Send Ctrl-C first
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

  scrub(configId, "stopped")
  await reconcileRuntime([configId])
  log.info("process stopped", { configId, ptyId })
}

/**
 * Restart a process by config ID or pty ID.
 */
export async function restart(configIdOrPtyId: string): Promise<Process.LaunchResult> {
  const { configId } = resolveProcess(configIdOrPtyId)
  if (!state().configs.has(configId)) return miss()
  await stop(configId)

  // Reset restart count on manual restart
  const s = state()
  const existing = s.processes.get(configId)
  if (existing) {
    existing.restartCount = 0
    s.processes.set(configId, existing)
  }

  // Restart is non-interactive — default to pick-new if preferred port is occupied
  const result = await start(configId, { portConflict: "pick-new" })
  if (result.kind === "port_conflict") {
    return fail(`Unexpected port conflict while restarting process: ${configId}`)
  }
  return result
}

/**
 * Topologically sort configs by dependencies.
 * Returns config IDs in an order where dependencies come first.
 */
function topologicalSort(configIds: string[]): string[] {
  const s = state()
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

    for (const depId of deps(id, idSet)) {
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
 * Uses topological sort to respect dependency order.
 * Dependencies are started even if they don't have autoStart=true.
 */
export async function startAll(): Promise<void> {
  const s = state()
  await reconcileRuntime()
  const autoStartIds = Array.from(s.configs.entries())
    .filter(([, config]) => config.autoStart)
    .map(([id]) => id)

  // Collect all dependency IDs (including transitive) that need starting
  const allIds = new Set<string>(autoStartIds)
  for (const id of autoStartIds) {
    try {
      const deps = resolveDependencyOrder(id)
      for (const depId of deps) allIds.add(depId)
    } catch (err) {
      log.error("dependency resolution failed in startAll", { id, err: String(err) })
    }
  }

  const sorted = topologicalSort(Array.from(allIds))
  const started: string[] = []

  for (const configId of sorted) {
    const proc = s.processes.get(configId)
    if (proc && (proc.status === "running" || proc.status === "starting")) continue
    // Non-interactive: default to pick-new if no onConflict is configured
    await start(configId, { portConflict: "pick-new" })
    started.push(s.configs.get(configId)?.name ?? configId)
  }

  if (started.length) {
    log.info("auto-started processes", { names: started })
  }
}

/**
 * Stop all running processes in reverse config order.
 */
export async function stopAll(): Promise<void> {
  const s = state()
  const configIds = Array.from(s.configs.keys()).reverse()
  for (const configId of configIds) {
    const proc = s.processes.get(configId)
    if (proc && (proc.status === "running" || proc.status === "starting" || proc.status === "restarting")) {
      await stop(configId)
    }
  }
  await reconcileRuntime(configIds)
  log.info("all processes stopped")
}

/**
 * Get a managed process by config ID.
 */
export function get(configId: string): Process.ManagedProcess | undefined {
  return state().processes.get(configId)
}

/**
 * List all managed processes.
 */
export function list(): Process.ManagedProcess[] {
  return Array.from(state().processes.values())
}

/**
 * Get all loaded process configs.
 */
export function configs(): Process.ProcessConfig[] {
  return Array.from(state().configs.values())
}

/**
 * Apply restart policy after a process crash / command exit.
 */
function applyRestartPolicy(
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

  const s = state()
  // Exponential backoff: min(1000 * 2^restartCount, 30000)ms
  const delay = Math.min(1000 * Math.pow(2, proc.restartCount), 30000)
  proc.restartCount++
  proc.status = "restarting"
  s.processes.set(configId, proc)
  Bus.publish(Process.Event.Status, { configId, status: "restarting" })

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
    // Auto-restart is non-interactive — default to pick-new
    start(configId, { portConflict: "pick-new" })
  }, delay)
}

/**
 * Initialize the exit handler that monitors PTY exits and applies restart policies.
 */
export function initExitHandler(): () => void {
  const unsub = Bus.subscribe(Pty.Event.Exited, (event) => {
    const { id: ptyId, exitCode } = event.properties
    const s = state()

    // Find the managed process with this ptyId
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

    // Unregister port from global registry on any exit
    if (proc.assignedPort !== undefined) {
      unregisterPort(proc.assignedPort)
    }

    // Update process state
    proc.exitCode = exitCode
    proc.exitedAt = Date.now()

    if (proc.status === "stopping") {
      proc.status = "stopped"
      // Clear ptyId — user-initiated stop destroys the PTY, so GET /process/
      // returns clean state (no stale ptyId for the frontend to render).
      proc.ptyId = undefined
      proc.assignedPort = undefined
      s.processes.set(configId, proc)
      Bus.publish(Process.Event.Stopped, { configId, exitCode })
      Bus.publish(Process.Event.Status, { configId, status: "stopped" })
      void reconcileRuntime([configId])
      return
    }

    // Process crashed (unexpected exit — the PTY itself is dead).
    // This only fires when the PTY/shell itself dies.
    proc.status = "crashed"
    proc.ptyId = undefined
    proc.assignedPort = undefined
    s.processes.set(configId, proc)
    // ptyId is undefined here (PTY is dead) — client will show "Crashed" without terminal
    Bus.publish(Process.Event.Crashed, { configId, exitCode, restartCount: proc.restartCount })
    Bus.publish(Process.Event.Status, { configId, status: "crashed" })
    void reconcileRuntime([configId])

    if (!config) return
    applyRestartPolicy(configId, proc, config, exitCode)
  })

  // Subscribe to command-exit events (inner command exited inside interactive shell).
  // The shell/PTY stays alive, but the actual dev server / user command is dead.
  const unsubCommandExit = Bus.subscribe(Pty.Event.Stream, (event) => {
    const { id: ptyId, kind, exitCode } = event.properties
    if (kind !== "command-exit") return
    if (exitCode === undefined) return

    const s = state()

    // Find the managed process with this ptyId
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

    // Only react if the process is currently "running"
    if (proc.status !== "running") return

    // Unregister port from global registry on command-exit crash
    if (proc.assignedPort !== undefined) {
      unregisterPort(proc.assignedPort)
    }

    const config = s.configs.get(configId)

    proc.exitCode = exitCode
    proc.exitedAt = Date.now()
    proc.status = "crashed"
    proc.assignedPort = undefined
    s.processes.set(configId, proc)
    Bus.publish(Process.Event.Crashed, { configId, exitCode, restartCount: proc.restartCount, commandExit: true, ptyId: proc.ptyId })
    Bus.publish(Process.Event.Status, { configId, status: "crashed" })
    log.info("inner command exited", { configId, ptyId, exitCode })
    void reconcileRuntime([configId])

    if (!config) return
    applyRestartPolicy(configId, proc, config, exitCode)
  })

  state().dispose = () => {
    unsub()
    unsubCommandExit()
  }
  return () => {
    unsub()
    unsubCommandExit()
  }
}

/**
 * Add a new process config and persist to disk.
 */
export async function addConfig(
  input: Omit<Process.ProcessConfig, "id"> & { id?: string },
): Promise<Process.ProcessConfig> {
  const config = Process.ProcessConfig.parse({
    ...input,
    id: input.id || Process.createId(),
  })
  const s = state()
  s.configs.set(config.id, config)
  // Create an idle ManagedProcess entry so GET /process/ returns it
  // immediately (consistent with reconcileFromDisk behaviour).
  s.processes.set(config.id, idle(config.id))
  await saveConfig(Array.from(s.configs.values()))
  return config
}

/**
 * Update an existing process config and persist to disk.
 * If the process is running, it will be restarted with the new config.
 */
export async function updateConfig(
  id: string,
  updates: Partial<Omit<Process.ProcessConfig, "id">>,
): Promise<Process.ProcessConfig> {
  const s = state()
  const existing = s.configs.get(id)
  if (!existing) throw new Error(`Process config not found: ${id}`)
  const updated = Process.ProcessConfig.parse({ ...existing, ...updates, id })
  if (!samePort(existing.port, updated.port)) {
    await Lease.drop(key(id))
  }
  s.configs.set(id, updated)
  await saveConfig(Array.from(s.configs.values()))

  // Restart if running with new config
  const proc = s.processes.get(id)
  if (proc && (proc.status === "running" || proc.status === "starting")) {
    await restart(id)
  }

  return updated
}

/**
 * Remove a process config. Stops the process if running, then persists.
 */
export async function removeConfig(id: string): Promise<void> {
  const s = state()
  if (!s.configs.has(id)) throw new Error(`Process config not found: ${id}`)
  const proc = s.processes.get(id)
  if (proc && (proc.status === "running" || proc.status === "starting" || proc.status === "restarting")) {
    await stop(id)
  }
  await Lease.drop(key(id))
  await reconcileRuntime([id])
  s.configs.delete(id)
  s.processes.delete(id)
  await saveConfig(Array.from(s.configs.values()))
}

/**
 * Get a single process config by ID.
 */
export function getConfig(id: string): Process.ProcessConfig | undefined {
  return state().configs.get(id)
}

// --- Exported helpers ---

export function findByName(name: string): Process.ManagedProcess | undefined {
  const s = state()
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
export function findByPortName(name: string): { configId: string; config: Process.ProcessConfig; proc: Process.ManagedProcess } | undefined {
  const s = state()
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
export function portMap(): Record<string, number> {
  const s = state()
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

export function resolveProcess(configIdOrPtyId: string): { configId: string; proc: Process.ManagedProcess | undefined } {
  const s = state()

  // Try config ID first
  const proc = s.processes.get(configIdOrPtyId)
  if (proc) {
    return { configId: configIdOrPtyId, proc }
  }

  // Try pty ID
  for (const [configId, p] of s.processes) {
    if (p.ptyId === configIdOrPtyId) {
      return { configId, proc: p }
    }
  }

  return { configId: configIdOrPtyId, proc: undefined }
}
