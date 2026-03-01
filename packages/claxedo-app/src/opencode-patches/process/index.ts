/**
 * Process Manager (Claxedo)
 *
 * Manages long-running user-defined processes (dev servers, watchers, etc.)
 * backed by PTY sessions. Processes are declared in `.opencode/processes.jsonc`
 * and support auto-start, restart policies, and graceful shutdown.
 */

import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Pty } from "@/pty"
import { Log } from "@/util/log"
import { parse as parseJsonc } from "jsonc-parser"
import path from "path"
import fs from "fs/promises"
import { watch, type FSWatcher } from "node:fs"
import { buildSafeEnv } from "../pty/env"
import { Process } from "./process"
import { buildPortlessCommand, configChanged, resolvePortlessBin } from "./portless"

export { Process, buildPortlessCommand, configChanged }

const log = Log.create({ service: "process" })

const PORTLESS_PORT = 1355

async function isPortlessRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORTLESS_PORT}/`, {
      method: "HEAD",
      signal: AbortSignal.timeout(500),
    })
    return res.headers.get("x-portless") === "1"
  } catch {
    return false
  }
}

async function ensurePortlessDaemon(): Promise<void> {
  if (await isPortlessRunning()) return

  const portlessBin = await resolvePortlessBin()
  if (!portlessBin) {
    log.warn("portless binary not found, skipping daemon start")
    return
  }

  log.info("starting portless daemon")
  const proc = Bun.spawn([portlessBin, "proxy", "start"], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  })
  await proc.exited

  // Poll for readiness (max 5s)
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250))
    if (await isPortlessRunning()) {
      log.info("portless daemon ready")
      return
    }
  }
  log.warn("portless daemon did not start within timeout")
}

const CONFIG_FILE = ".opencode/processes.jsonc"

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
    s.dispose?.()
    if (s.debounceTimer) clearTimeout(s.debounceTimer)
    try {
      s.watcher?.close()
    } catch {}
    // Stop all managed processes
    for (const [configId, proc] of s.processes) {
      if (proc.ptyId && (proc.status === "running" || proc.status === "starting")) {
        try {
          await Pty.remove(proc.ptyId)
        } catch {}
      }
    }
    s.processes.clear()
    s.configs.clear()
  },
)

function configPath(): string {
  return path.join(Instance.directory, CONFIG_FILE)
}

/**
 * Load process configs from `.opencode/processes.jsonc`.
 * Returns the parsed configs or an empty array on error.
 */
export async function loadConfig(): Promise<Process.ProcessConfig[]> {
  const filePath = configPath()
  try {
    const content = await fs.readFile(filePath, "utf-8")
    const raw = parseJsonc(content)
    const parsed = Process.ProcessConfigFile.parse(raw)
    const s = state()
    s.configs.clear()
    for (const config of parsed.processes) {
      s.configs.set(config.id, config)
    }
    log.info("loaded process configs", { count: parsed.processes.length })
    return parsed.processes
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      log.info("no process config file found", { path: filePath })
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
  const filePath = configPath()
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })

  const file: Process.ProcessConfigFile = {
    processes: configs,
  }
  await fs.writeFile(filePath, JSON.stringify(file, null, 2) + "\n", "utf-8")

  const s = state()
  s.configs.clear()
  for (const config of configs) {
    s.configs.set(config.id, config)
  }

  Bus.publish(Process.Event.ConfigChanged, { configs })
  log.info("saved process configs", { count: configs.length })
}

/**
 * Watch `.opencode/processes.jsonc` for changes.
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

  const dirPath = path.dirname(configPath())
  const filename = path.basename(configPath())

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
    log.info("watching config file", { path: configPath() })
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
  const filePath = configPath()

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
      s.configs.delete(id)
      s.processes.delete(id)
      log.info("config removed", { id })
    }
  }

  // Added configs: store with idle status
  for (const [id, config] of newById) {
    if (!oldIds.has(id)) {
      s.configs.set(id, config)
      s.processes.set(id, {
        configId: id,
        ptyId: undefined,
        status: "idle",
        restartCount: 0,
        exitCode: undefined,
        startedAt: undefined,
        exitedAt: undefined,
      })
      log.info("config added", { id, name: config.name })
    }
  }

  // Changed configs: update config and restart if running
  for (const [id, newConfig] of newById) {
    if (oldIds.has(id)) {
      const oldConfig = s.configs.get(id)!
      if (configChanged(oldConfig, newConfig)) {
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

  Bus.publish(Process.Event.ConfigChanged, { configs: newConfigs })
  log.info("config reconciled from disk", { count: newConfigs.length })
}

/**
 * Check if two process configs differ in execution-relevant fields.
 */
// configChanged and buildPortlessCommand imported from ./portless

/**
 * Start a process by config ID.
 */
export async function start(configId: string): Promise<Process.ManagedProcess | undefined> {
  const s = state()
  const config = s.configs.get(configId)
  if (!config) {
    log.error("config not found", { configId })
    return undefined
  }

  // Check if already running
  const existing = s.processes.get(configId)
  if (existing && (existing.status === "running" || existing.status === "starting")) {
    log.info("process already running", { configId, status: existing.status })
    return existing
  }

  const cwd = config.cwd ? path.resolve(Instance.directory, config.cwd) : Instance.directory

  const env: Record<string, string> = {
    ...buildSafeEnv(process.env, { customPrefix: "CLAXEDO" }),
    ...(config.env || {}),
    OPENCODE_TERMINAL: "1",
    OPENCODE_PROCESS: config.name,
    OPENCODE_PROCESS_ID: configId,
  }

  // Ensure portless binary's directory is in PATH
  if (config.portless) {
    const portlessBin = await resolvePortlessBin()
    if (portlessBin) {
      const binDir = path.dirname(portlessBin)
      if (env.PATH && !env.PATH.includes(binDir)) {
        env.PATH = `${binDir}${path.delimiter}${env.PATH}`
      }
    }
  }

  const proc: Process.ManagedProcess = {
    configId,
    ptyId: undefined,
    status: "starting",
    restartCount: existing?.restartCount ?? 0,
    exitCode: undefined,
    startedAt: Date.now(),
    exitedAt: undefined,
  }
  s.processes.set(configId, proc)
  Bus.publish(Process.Event.Status, { configId, status: "starting" })

  try {
    // Start a persistent interactive shell. The command runs INSIDE the shell,
    // so when it crashes/exits the shell (and terminal) stays alive — the user
    // sees the exit status and can interact or re-run.
    const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh")
    let fullCommand = config.args?.length
      ? [config.command, ...config.args].join(" ")
      : config.command

    if (config.portless) {
      await ensurePortlessDaemon()
      const portlessBin = await resolvePortlessBin()
      if (!portlessBin) {
        log.warn("portless binary not found, running without portless", { configId })
      } else {
        const hostname = config.portless.hostname.trim().toLowerCase()
        const mode = config.portless.portMode || "env"
        const value = config.portless.portValue || "PORT"
        fullCommand = buildPortlessCommand(fullCommand, portlessBin, hostname, mode, value)
      }
    }

    const info = await Pty.create({
      command: shell,
      args: [],   // interactive shell — no -c flag
      cwd,
      title: config.name,
      env,
    })

    proc.ptyId = info.id
    proc.status = "running"
    s.processes.set(configId, proc)

    // Send the command to the interactive shell.
    // Wait for the shell to initialize (load rc files, print prompt).
    // There is no PTY "shell ready" event, so we use a delay heuristic.
    await new Promise((r) => setTimeout(r, 250))
    try {
      Pty.write(info.id, fullCommand + "; printf '\\033]777;process-exit;%d\\007' $?\n")
    } catch (e) {
      log.warn("failed to write command to process shell", { configId, ptyId: info.id, err: String(e) })
    }

    Bus.publish(Process.Event.Started, { configId, ptyId: info.id })
    Bus.publish(Process.Event.Status, { configId, status: "running" })
    log.info("process started", { configId, name: config.name, ptyId: info.id })

    return proc
  } catch (err) {
    proc.status = "crashed"
    proc.exitedAt = Date.now()
    s.processes.set(configId, proc)
    Bus.publish(Process.Event.Status, { configId, status: "crashed" })
    log.error("failed to start process", { configId, err: String(err) })
    return proc
  }
}

/**
 * Stop a process by config ID or pty ID.
 * Sends Ctrl-C first, then SIGTERM after 2s, then SIGKILL after 5s.
 */
export async function stop(configIdOrPtyId: string, signal?: string): Promise<void> {
  const s = state()
  const { configId, proc } = resolveProcess(configIdOrPtyId)
  if (!proc || !proc.ptyId) {
    log.info("no running process to stop", { id: configIdOrPtyId })
    return
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
  try {
    Pty.write(ptyId, "\x03")
  } catch {}

  // Wait 2s, then SIGTERM
  await new Promise<void>((resolve) => {
    const checkStopped = () => {
      const current = s.processes.get(configId)
      return !current || current.status === "stopped" || current.status === "crashed"
    }

    if (checkStopped()) return resolve()

    const timer2s = setTimeout(async () => {
      if (checkStopped()) return resolve()
      try {
        await Pty.remove(ptyId)
      } catch {}

      // Wait another 3s for SIGKILL fallback
      const timer5s = setTimeout(async () => {
        if (checkStopped()) return resolve()
        // Force kill if still alive
        const info = Pty.get(ptyId)
        if (info && info.status === "running") {
          try {
            process.kill(info.pid, "SIGKILL")
          } catch {}
        }
        resolve()
      }, 3000)

      // If it exits before the 3s, resolve early
      const unsub = Bus.subscribe(Pty.Event.Exited, (event) => {
        if (event.properties.id === ptyId) {
          clearTimeout(timer5s)
          unsub()
          resolve()
        }
      })
    }, 2000)

    // If it exits before the 2s, resolve early
    const unsub = Bus.subscribe(Pty.Event.Exited, (event) => {
      if (event.properties.id === ptyId) {
        clearTimeout(timer2s)
        unsub()
        resolve()
      }
    })
  })

  log.info("process stopped", { configId, ptyId })
}

/**
 * Restart a process by config ID or pty ID.
 */
export async function restart(configIdOrPtyId: string): Promise<Process.ManagedProcess | undefined> {
  const { configId } = resolveProcess(configIdOrPtyId)
  await stop(configId)

  // Reset restart count on manual restart
  const s = state()
  const existing = s.processes.get(configId)
  if (existing) {
    existing.restartCount = 0
    s.processes.set(configId, existing)
  }

  return start(configId)
}

/**
 * Start all processes with autoStart=true that are not already running.
 */
export async function startAll(): Promise<void> {
  const s = state()
  const started: string[] = []
  for (const [configId, config] of s.configs) {
    if (!config.autoStart) continue
    const proc = s.processes.get(configId)
    if (proc && (proc.status === "running" || proc.status === "starting")) continue
    await start(configId)
    started.push(config.name)
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
  setTimeout(() => {
    const current = s.processes.get(configId)
    if (current?.status !== "restarting") return
    start(configId)
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

    // Update process state
    proc.exitCode = exitCode
    proc.exitedAt = Date.now()

    if (proc.status === "stopping") {
      proc.status = "stopped"
      // Clear ptyId — user-initiated stop destroys the PTY, so GET /process/
      // returns clean state (no stale ptyId for the frontend to render).
      proc.ptyId = undefined
      s.processes.set(configId, proc)
      Bus.publish(Process.Event.Stopped, { configId, exitCode })
      Bus.publish(Process.Event.Status, { configId, status: "stopped" })
      return
    }

    // Process crashed (unexpected exit — the PTY itself is dead).
    // This only fires when the PTY/shell itself dies.
    proc.status = "crashed"
    proc.ptyId = undefined
    s.processes.set(configId, proc)
    // ptyId is undefined here (PTY is dead) — client will show "Crashed" without terminal
    Bus.publish(Process.Event.Crashed, { configId, exitCode, restartCount: proc.restartCount })
    Bus.publish(Process.Event.Status, { configId, status: "crashed" })

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

    const config = s.configs.get(configId)

    proc.exitCode = exitCode
    proc.exitedAt = Date.now()
    proc.status = "crashed"
    s.processes.set(configId, proc)
    Bus.publish(Process.Event.Crashed, { configId, exitCode, restartCount: proc.restartCount, commandExit: true, ptyId: proc.ptyId })
    Bus.publish(Process.Event.Status, { configId, status: "crashed" })
    log.info("inner command exited", { configId, ptyId, exitCode })

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
  s.processes.set(config.id, {
    configId: config.id,
    ptyId: undefined,
    status: "idle",
    restartCount: 0,
    exitCode: undefined,
    startedAt: undefined,
    exitedAt: undefined,
  })
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

// --- Internal helpers ---

function resolveProcess(configIdOrPtyId: string): { configId: string; proc: Process.ManagedProcess | undefined } {
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
