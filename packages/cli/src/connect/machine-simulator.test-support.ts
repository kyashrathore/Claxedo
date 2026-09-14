/**
 * A machine for `claxedo connect --install-service` to run on: a service
 * manager that reads the unit the CLI wrote and runs its ExecStart as a real
 * child process, applying the unit's own restart policy to every exit, plus a
 * cloud-init-shaped `provision`. The systemd user manager is what the CLI
 * installs on Linux; launchd is what it installs on macOS, where the Tier R
 * fixture runs the real binary. Node APIs only: the fixture imports this under
 * tsx, the CLI's tests under bun.
 *
 * The manager is a policy model, not a re-implementation: it keeps what
 * `systemctl show` / `launchctl print` would report and nothing a test does
 * not read.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process"
import { lstatSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { LAUNCHD_LABEL, SYSTEMD_UNIT, serviceKind, type CommandResult, type ServiceDeps } from "./service"

const execFileAsync = promisify(execFile)

export type Timer = { cancel: () => void }
export type SetTimeoutLike = (fn: () => void, ms: number) => Timer

export const realSetTimeout: SetTimeoutLike = (fn, ms) => {
  const handle = setTimeout(fn, ms)
  return { cancel: () => clearTimeout(handle) }
}

/** systemd's word splitting for ExecStart= and Environment=: whitespace outside quotes; `\"` and `\\` inside double quotes. */
export function splitSystemdWords(line: string): string[] {
  const words: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  let inWord = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < line.length) {
        current += line[i + 1]
        i += 1
        continue
      }
      if (ch === quote) {
        quote = undefined
        continue
      }
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      inWord = true
      continue
    }
    if (/\s/.test(ch)) {
      if (inWord) {
        words.push(current)
        current = ""
        inWord = false
      }
      continue
    }
    inWord = true
    current += ch
  }
  if (inWord) words.push(current)
  return words
}

export type SystemdUnit = {
  execStart: string[]
  environment: Record<string, string>
  restart: string
  restartSec: number
  restartPreventExitStatus: Set<number>
  timeoutStopSec: number
  wantedBy: string | undefined
}

export function parseSystemdUnit(text: string): SystemdUnit {
  const unit: SystemdUnit = {
    execStart: [],
    environment: {},
    restart: "no",
    restartSec: 0.1,
    restartPreventExitStatus: new Set(),
    timeoutStopSec: 90,
    wantedBy: undefined,
  }
  let section = ""
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#") || line.startsWith(";")) continue
    const header = /^\[(.+)\]$/.exec(line)
    if (header) {
      section = header[1]!
      continue
    }
    const eq = line.indexOf("=")
    if (eq < 0) continue
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1)
    if (section === "Service") {
      if (key === "ExecStart") unit.execStart = splitSystemdWords(value)
      else if (key === "Restart") unit.restart = value
      else if (key === "RestartSec") unit.restartSec = Number(value.replace(/s$/, ""))
      else if (key === "RestartPreventExitStatus") {
        for (const status of value.split(/\s+/).filter(Boolean)) unit.restartPreventExitStatus.add(Number(status))
      } else if (key === "TimeoutStopSec") unit.timeoutStopSec = Number(value.replace(/s$/, ""))
      else if (key === "Environment") {
        for (const word of splitSystemdWords(value)) {
          const at = word.indexOf("=")
          if (at > 0) unit.environment[word.slice(0, at)] = word.slice(at + 1)
        }
      }
    } else if (section === "Install" && key === "WantedBy") unit.wantedBy = value
  }
  return unit
}

export type LaunchdJob = {
  label: string
  programArguments: string[]
  environment: Record<string, string>
  runAtLoad: boolean
  /** `KeepAlive.SuccessfulExit=false`: restart after every non-zero exit, never after zero. */
  restartUnlessSuccessful: boolean
  throttleIntervalS: number
}

function xmlUnescape(value: string) {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
}

/** The plist `launchdPlist()` writes, read back; keys the CLI does not write take launchd's defaults. */
export function parseLaunchdPlist(text: string): LaunchdJob {
  const stringAfter = (key: string) => {
    const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text)
    return match ? xmlUnescape(match[1]!) : undefined
  }
  const label = stringAfter("Label")
  if (!label) throw new Error("plist has no Label")
  const argsBlock = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? ""
  const programArguments = [...argsBlock.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => xmlUnescape(match[1]!))
  const environment: Record<string, string> = {}
  const envBlock = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text)?.[1] ?? ""
  for (const match of envBlock.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) environment[match[1]!] = xmlUnescape(match[2]!)
  const keepAlive = /<key>KeepAlive<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text)?.[1] ?? ""
  return {
    label,
    programArguments,
    environment,
    runAtLoad: /<key>RunAtLoad<\/key>\s*<true\/>/.test(text),
    restartUnlessSuccessful: /<key>SuccessfulExit<\/key>\s*<false\/>/.test(keepAlive),
    throttleIntervalS: Number(/<key>ThrottleInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(text)?.[1] ?? 10),
  }
}

export type MainProcessExit = { code: number | null; signal: NodeJS.Signals | null }

/** What both managers report about their one service, in the manager's own vocabulary and in a shared one. */
export type ServiceView = {
  kind: "systemd-user" | "launchd"
  loaded: boolean
  enabled: boolean
  running: boolean
  pid: number | undefined
  /** `ActiveState/SubState` for systemd, launchd's `state` for launchd. */
  state: string
  restarts: number
  lastExit: MainProcessExit | undefined
  /** `systemctl show` / `launchctl print` as the manager prints it. */
  raw: string
}

export type FakeServiceManager = {
  kind: "systemd-user" | "launchd"
  /** The CLI's exec seam: `systemctl`, `loginctl` and `launchctl` as this machine answers them. */
  run: (file: string, args: readonly string[]) => Promise<CommandResult>
  /** Every command run, as one line each. */
  calls: string[]
  /** Every restart wait the manager was asked for, in ms, whether or not the injected timer shortened it. */
  restartWaitsMs: number[]
  service: () => ServiceView
  /** The service's stdout and stderr since the manager last (re)started. */
  journal: () => string
  /** The main process, while one runs. */
  child: () => ChildProcess | undefined
  /**
   * Power loss, then a boot: every process is SIGKILLed with no stop job,
   * the manager forgets its runtime state, and what the disk says is enabled
   * is started again.
   */
  reboot: () => Promise<{ bootedAt: number }>
  /** `ServiceDeps` for `connect()` run in-process against this machine. */
  serviceDeps: (input: { command: readonly string[]; claxedoHome: string; now?: () => number }) => ServiceDeps
  /** SIGKILL everything and stop restarting; the end of a test. */
  dispose: () => Promise<void>
}

export type FakeManagerOptions = {
  home: string
  username: string
  /** The environment block the manager hands every service, before the unit's own `Environment=`. */
  environment: Record<string, string>
  /** `WorkingDirectory=` for every service. */
  cwd: string
  setTimeout?: SetTimeoutLike
  /** Called with each main process the manager starts, including restarts. */
  onChild?: (child: ChildProcess) => void
  log?: (line: string) => void
}

export type FakeSystemdOptions = FakeManagerOptions & {
  /** `loginctl enable-linger`: a user manager exists outside a login session only with it. */
  linger: boolean
  /** `XDG_RUNTIME_DIR`; unset models a shell that cannot reach the user bus. */
  runtimeDir: string | undefined
}

type Tracked = {
  child: ChildProcess | undefined
  exited: Promise<MainProcessExit> | undefined
  pid: number | undefined
  journal: string
}

function track(child: ChildProcess, tracked: Tracked, onChild: ((child: ChildProcess) => void) | undefined) {
  tracked.child = child
  tracked.pid = child.pid
  tracked.journal = ""
  child.stdout?.on("data", (chunk: Buffer) => {
    tracked.journal += chunk.toString()
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    tracked.journal += chunk.toString()
  })
  tracked.exited = new Promise<MainProcessExit>((resolve) => {
    child.once("error", (error) => {
      tracked.journal += `spawn failed: ${error.message}\n`
      resolve({ code: 203, signal: null })
    })
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
  onChild?.(child)
  return tracked.exited
}

const alive = (child: ChildProcess | undefined) => child !== undefined && child.exitCode === null && child.signalCode === null

const signalNumber = (signal: NodeJS.Signals) => os.constants.signals[signal] ?? 0

export function createFakeSystemdUserManager(options: FakeSystemdOptions): FakeServiceManager {
  const setTimer = options.setTimeout ?? realSetTimeout
  const unitDir = path.join(options.home, ".config", "systemd", "user")
  const wantsDir = path.join(unitDir, "default.target.wants")
  const calls: string[] = []
  const restartWaitsMs: number[] = []
  const busReachable = () => options.linger && options.runtimeDir !== undefined
  let phase: "running" | "shutdown" = "running"

  type Unit = {
    name: string
    file: string
    unit: SystemdUnit
    activeState: "inactive" | "activating" | "active" | "deactivating" | "failed"
    subState: "dead" | "auto-restart" | "running" | "stop-sigterm" | "failed"
    result: "success" | "exit-code" | "signal"
    nRestarts: number
    execMainCode: 0 | 1 | 2
    execMainStatus: number
    lastExit: MainProcessExit | undefined
    stopping: boolean
    restartTimer: Timer | undefined
  } & Tracked
  const units = new Map<string, Unit>()

  const load = async (name: string): Promise<Unit> => {
    const file = path.join(unitDir, name)
    const text = await fs.readFile(file, "utf8").catch(() => undefined)
    if (text === undefined) throw new Error(`Unit ${name} not found.`)
    const parsed = parseSystemdUnit(text)
    const existing = units.get(name)
    if (existing) {
      existing.unit = parsed
      return existing
    }
    const unit: Unit = {
      name,
      file,
      unit: parsed,
      activeState: "inactive",
      subState: "dead",
      result: "success",
      nRestarts: 0,
      execMainCode: 0,
      execMainStatus: 0,
      lastExit: undefined,
      stopping: false,
      restartTimer: undefined,
      child: undefined,
      exited: undefined,
      pid: undefined,
      journal: "",
    }
    units.set(name, unit)
    return unit
  }

  const isEnabled = (name: string) =>
    fs
      .lstat(path.join(wantsDir, name))
      .then(() => true)
      .catch(() => false)

  const settle = (unit: Unit, exit: MainProcessExit) => {
    unit.lastExit = exit
    if (exit.signal) {
      unit.execMainCode = 2
      unit.execMainStatus = signalNumber(exit.signal)
      unit.result = "signal"
    } else {
      unit.execMainCode = 1
      unit.execMainStatus = exit.code ?? 0
      unit.result = exit.code === 0 ? "success" : "exit-code"
    }
    unit.child = undefined
    if (phase === "shutdown") return
    if (unit.stopping || unit.result === "success") {
      unit.stopping = false
      unit.activeState = "inactive"
      unit.subState = "dead"
      return
    }
    const prevented = exit.code !== null && unit.unit.restartPreventExitStatus.has(exit.code)
    if (prevented || unit.unit.restart === "no") {
      unit.activeState = "failed"
      unit.subState = "failed"
      return
    }
    unit.activeState = "activating"
    unit.subState = "auto-restart"
    const waitMs = unit.unit.restartSec * 1000
    restartWaitsMs.push(waitMs)
    unit.restartTimer = setTimer(() => {
      unit.restartTimer = undefined
      unit.nRestarts += 1
      start(unit)
    }, waitMs)
  }

  const start = (unit: Unit) => {
    if (alive(unit.child)) return
    unit.restartTimer?.cancel()
    unit.restartTimer = undefined
    const [file, ...args] = unit.unit.execStart
    if (!file) throw new Error(`${unit.name} has no ExecStart`)
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: { ...options.environment, ...unit.unit.environment },
      stdio: ["ignore", "pipe", "pipe"],
    })
    unit.activeState = "active"
    unit.subState = "running"
    unit.execMainCode = 0
    unit.execMainStatus = 0
    void track(child, unit, options.onChild).then((exit) => {
      options.log?.(`${unit.name}: main process exited ${JSON.stringify(exit)}`)
      settle(unit, exit)
    })
  }

  const stop = async (unit: Unit) => {
    if (!alive(unit.child)) return
    unit.stopping = true
    unit.activeState = "deactivating"
    unit.subState = "stop-sigterm"
    const child = unit.child!
    const killer = setTimer(() => child.kill("SIGKILL"), unit.unit.timeoutStopSec * 1000)
    child.kill("SIGTERM")
    await unit.exited
    killer.cancel()
  }

  const show = (unit: Unit, enabled: boolean) =>
    [
      `Id=${unit.name}`,
      "LoadState=loaded",
      `ActiveState=${unit.activeState}`,
      `SubState=${unit.subState}`,
      `UnitFileState=${enabled ? "enabled" : "disabled"}`,
      `Restart=${unit.unit.restart}`,
      `RestartUSec=${unit.unit.restartSec}s`,
      `NRestarts=${unit.nRestarts}`,
      `ExecMainPID=${alive(unit.child) ? unit.pid : 0}`,
      `ExecMainCode=${unit.execMainCode}`,
      `ExecMainStatus=${unit.execMainStatus}`,
      `Result=${unit.result}`,
      "",
    ].join("\n")

  const run = async (file: string, args: readonly string[]): Promise<CommandResult> => {
    calls.push([file, ...args].join(" "))
    if (file === "loginctl") {
      // No session and no lingering: loginctl knows no such user.
      return options.linger ? { code: 0, stdout: "yes\n" } : { code: 1, stdout: "" }
    }
    if (file !== "systemctl") return { code: 127, stdout: "" }
    if (args[0] !== "--user") return { code: 1, stdout: "" }
    // "Failed to connect to bus": every answer is empty, including is-system-running's.
    if (!busReachable()) return { code: 1, stdout: "" }
    const verb = args[1]
    const name = args[args.length - 1]!
    try {
      if (verb === "is-system-running") return { code: 0, stdout: "running\n" }
      if (verb === "daemon-reload") {
        for (const name of units.keys()) await load(name)
        return { code: 0, stdout: "" }
      }
      if (verb === "enable") {
        const unit = await load(name)
        await fs.mkdir(wantsDir, { recursive: true })
        await fs.symlink(path.join("..", name), path.join(wantsDir, name)).catch((error: unknown) => {
          if ((error as { code?: string }).code !== "EEXIST") throw error
        })
        if (args.includes("--now")) start(unit)
        return { code: 0, stdout: "" }
      }
      if (verb === "disable") {
        const unit = units.get(name)
        if (args.includes("--now") && unit) await stop(unit)
        await fs.rm(path.join(wantsDir, name), { force: true })
        return { code: 0, stdout: "" }
      }
      if (verb === "start") {
        start(await load(name))
        return { code: 0, stdout: "" }
      }
      if (verb === "stop") {
        const unit = units.get(name)
        if (unit) await stop(unit)
        return { code: 0, stdout: "" }
      }
      if (verb === "show") {
        const unit = units.get(name) ?? (await load(name))
        return { code: 0, stdout: show(unit, await isEnabled(name)) }
      }
      return { code: 1, stdout: "" }
    } catch (error) {
      options.log?.(`systemctl ${args.join(" ")}: ${error instanceof Error ? error.message : String(error)}`)
      return { code: 1, stdout: "" }
    }
  }

  const only = () => units.get(SYSTEMD_UNIT)

  const isEnabledSync = (name: string) => {
    try {
      lstatSync(path.join(wantsDir, name))
      return true
    } catch {
      return false
    }
  }

  const killAll = async () => {
    for (const unit of units.values()) {
      unit.restartTimer?.cancel()
      unit.restartTimer = undefined
      if (!alive(unit.child)) continue
      unit.child!.kill("SIGKILL")
      await unit.exited
    }
  }

  return {
    kind: "systemd-user",
    run,
    calls,
    restartWaitsMs,
    child: () => only()?.child,
    journal: () => only()?.journal ?? "",
    service: () => {
      const unit = only()
      const enabled = isEnabledSync(SYSTEMD_UNIT)
      if (!unit) return { kind: "systemd-user", loaded: false, enabled, running: false, pid: undefined, state: "not-found", restarts: 0, lastExit: undefined, raw: "" }
      return {
        kind: "systemd-user",
        loaded: true,
        enabled,
        running: alive(unit.child),
        pid: alive(unit.child) ? unit.pid : undefined,
        state: `${unit.activeState}/${unit.subState}`,
        restarts: unit.nRestarts,
        lastExit: unit.lastExit,
        raw: show(unit, enabled),
      }
    },
    reboot: async () => {
      phase = "shutdown"
      await killAll()
      units.clear()
      phase = "running"
      const bootedAt = Date.now()
      if (options.linger) {
        const enabled = await fs.readdir(wantsDir).catch(() => [] as string[])
        for (const name of enabled) start(await load(name))
      }
      return { bootedAt }
    },
    serviceDeps: (input) => ({
      platform: "linux",
      homedir: options.home,
      username: options.username,
      command: input.command,
      claxedoHome: input.claxedoHome,
      env: options.runtimeDir === undefined ? {} : { XDG_RUNTIME_DIR: options.runtimeDir },
      run,
      writeFile: async (file, text) => {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, text, { mode: 0o644 })
      },
      unlink: async (file) => {
        await fs.rm(file, { force: true })
      },
      now: input.now ?? (() => Date.now()),
    }),
    dispose: async () => {
      phase = "shutdown"
      await killAll()
    },
  }
}

export type FakeLaunchdOptions = FakeManagerOptions & { uid: number }

/**
 * launchd as the CLI's LaunchAgent sees it: `bootstrap` loads the plist and
 * runs it (RunAtLoad), `bootout` unloads it and ends its process, and
 * `KeepAlive.SuccessfulExit=false` relaunches after any non-zero exit once
 * ThrottleInterval has passed since the last launch. The wrapper script the
 * CLI writes boots itself out on 78, which is the only reason a decision is
 * not relaunched — this model has no exempt status of its own, like launchd.
 */
export function createFakeLaunchd(options: FakeLaunchdOptions): FakeServiceManager {
  const setTimer = options.setTimeout ?? realSetTimeout
  const agentsDir = path.join(options.home, "Library", "LaunchAgents")
  const domain = `gui/${options.uid}`
  const calls: string[] = []
  const restartWaitsMs: number[] = []
  let phase: "running" | "shutdown" = "running"

  type Job = {
    file: string
    job: LaunchdJob
    loaded: boolean
    runs: number
    lastStartedAt: number
    lastExit: MainProcessExit | undefined
    restartTimer: Timer | undefined
  } & Tracked
  const jobs = new Map<string, Job>()

  const launch = (job: Job) => {
    if (alive(job.child)) return
    job.restartTimer?.cancel()
    job.restartTimer = undefined
    const [file, ...args] = job.job.programArguments
    if (!file) throw new Error(`${job.job.label} has no ProgramArguments`)
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: { ...options.environment, ...job.job.environment },
      stdio: ["ignore", "pipe", "pipe"],
    })
    job.runs += 1
    job.lastStartedAt = Date.now()
    void track(child, job, options.onChild).then((exit) => {
      options.log?.(`${job.job.label}: exited ${JSON.stringify(exit)}`)
      job.lastExit = exit
      job.child = undefined
      if (phase === "shutdown" || !job.loaded) return
      if (exit.code === 0 || !job.job.restartUnlessSuccessful) return
      const waitMs = Math.max(0, job.job.throttleIntervalS * 1000 - (Date.now() - job.lastStartedAt))
      restartWaitsMs.push(waitMs)
      job.restartTimer = setTimer(() => {
        job.restartTimer = undefined
        launch(job)
      }, waitMs)
    })
  }

  const bootstrap = async (file: string) => {
    const text = await fs.readFile(file, "utf8")
    const parsed = parseLaunchdPlist(text)
    const existing = jobs.get(parsed.label)
    if (existing?.loaded) return { code: 37, stdout: "" }
    const job: Job = existing ?? {
      file,
      job: parsed,
      loaded: false,
      runs: 0,
      lastStartedAt: 0,
      lastExit: undefined,
      restartTimer: undefined,
      child: undefined,
      exited: undefined,
      pid: undefined,
      journal: "",
    }
    job.file = file
    job.job = parsed
    job.loaded = true
    jobs.set(parsed.label, job)
    if (parsed.runAtLoad) launch(job)
    return { code: 0, stdout: "" }
  }

  const print = (job: Job) =>
    [
      `${domain}/${job.job.label} = {`,
      `\tactive count = ${alive(job.child) ? 1 : 0}`,
      `\tpath = ${job.file}`,
      `\tstate = ${alive(job.child) ? "running" : "not running"}`,
      ...(alive(job.child) ? [`\tpid = ${job.pid}`] : []),
      `\truns = ${job.runs}`,
      ...(job.lastExit ? [`\tlast exit code = ${job.lastExit.signal ? `(signal ${job.lastExit.signal})` : job.lastExit.code}`] : []),
      "}",
      "",
    ].join("\n")

  const run = async (file: string, args: readonly string[]): Promise<CommandResult> => {
    calls.push([file, ...args].join(" "))
    if (file !== "launchctl") return { code: 127, stdout: "" }
    const verb = args[0]
    try {
      if (verb === "bootstrap") {
        if (args[1] !== domain) return { code: 1, stdout: "" }
        return await bootstrap(args[2]!)
      }
      if (verb === "bootout" || verb === "print") {
        const label = (args[1] ?? "").startsWith(`${domain}/`) ? args[1]!.slice(domain.length + 1) : undefined
        const job = label ? jobs.get(label) : undefined
        if (!job || !job.loaded) return { code: verb === "bootout" ? 3 : 113, stdout: "" }
        if (verb === "print") return { code: 0, stdout: print(job) }
        job.loaded = false
        job.restartTimer?.cancel()
        job.restartTimer = undefined
        // Not awaited: the CLI's wrapper calls this from inside the job on 78.
        if (alive(job.child)) job.child!.kill("SIGTERM")
        return { code: 0, stdout: "" }
      }
      return { code: 1, stdout: "" }
    } catch (error) {
      options.log?.(`launchctl ${args.join(" ")}: ${error instanceof Error ? error.message : String(error)}`)
      return { code: 1, stdout: "" }
    }
  }

  const only = () => jobs.get(LAUNCHD_LABEL)

  const killAll = async () => {
    for (const job of jobs.values()) {
      job.restartTimer?.cancel()
      job.restartTimer = undefined
      if (!alive(job.child)) continue
      job.child!.kill("SIGKILL")
      await job.exited
    }
  }

  return {
    kind: "launchd",
    run,
    calls,
    restartWaitsMs,
    child: () => only()?.child,
    journal: () => only()?.journal ?? "",
    service: () => {
      const job = only()
      if (!job) return { kind: "launchd", loaded: false, enabled: false, running: false, pid: undefined, state: "not loaded", restarts: 0, lastExit: undefined, raw: "" }
      return {
        kind: "launchd",
        loaded: job.loaded,
        enabled: job.loaded,
        running: alive(job.child),
        pid: alive(job.child) ? job.pid : undefined,
        state: job.loaded ? (alive(job.child) ? "running" : "not running") : "not loaded",
        restarts: Math.max(0, job.runs - 1),
        lastExit: job.lastExit,
        raw: job.loaded ? print(job) : "",
      }
    },
    // A LaunchAgent comes back at the user's next login, which is the boot a
    // machine with an auto-login user has.
    reboot: async () => {
      phase = "shutdown"
      await killAll()
      jobs.clear()
      phase = "running"
      const bootedAt = Date.now()
      const plists = (await fs.readdir(agentsDir).catch(() => [] as string[])).filter((name) => name.endsWith(".plist"))
      for (const name of plists) await bootstrap(path.join(agentsDir, name))
      return { bootedAt }
    },
    serviceDeps: (input) => ({
      platform: "darwin",
      homedir: options.home,
      username: options.username,
      command: input.command,
      claxedoHome: input.claxedoHome,
      env: {},
      run,
      writeFile: async (file, text) => {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, text, { mode: 0o644 })
      },
      unlink: async (file) => {
        await fs.rm(file, { force: true })
      },
      now: input.now ?? (() => Date.now()),
    }),
    dispose: async () => {
      phase = "shutdown"
      await killAll()
    },
  }
}

/** The manager the CLI would install into on `platform`, for a fixture that runs the real binary. */
export function createFakeServiceManager(
  platform: NodeJS.Platform,
  options: FakeManagerOptions & { linger: boolean; runtimeDir: string | undefined; uid: number },
): FakeServiceManager {
  return serviceKind(platform) === "systemd-user" ? createFakeSystemdUserManager(options) : createFakeLaunchd(options)
}

export const MANAGER_SHIMS = ["systemctl", "loginctl", "launchctl"] as const

/**
 * The commands a real `claxedo connect --install-service` process runs, as
 * executables on its PATH that forward to a fixture's manager over HTTP:
 * `POST <url> {id, file, args}` answering `{code, stdout}`. The CLI's
 * launchd wrapper script runs `launchctl bootout` from inside the job, so the
 * job's own PATH must carry these too.
 */
export async function writeManagerShims(dir: string) {
  await fs.mkdir(dir, { recursive: true })
  const script = [
    "#!/usr/bin/env node",
    "const file = require('node:path').basename(process.argv[1])",
    "const url = process.env.CLAXEDO_FAKE_MANAGER_URL",
    "const id = process.env.CLAXEDO_FAKE_MANAGER_INSTANCE",
    "if (!url || !id) { process.stderr.write(`${file}: CLAXEDO_FAKE_MANAGER_URL and CLAXEDO_FAKE_MANAGER_INSTANCE are required\\n`); process.exit(1) }",
    "fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, file, args: process.argv.slice(2) }) })",
    "  .then(async (response) => { const { code, stdout } = await response.json(); process.stdout.write(stdout ?? ''); process.exitCode = code })",
    "  .catch((error) => { process.stderr.write(`${file}: ${error.message}\\n`); process.exitCode = 1 })",
    "",
  ].join("\n")
  for (const name of MANAGER_SHIMS) await fs.writeFile(path.join(dir, name), script, { mode: 0o755 })
  return dir
}

export type ProvisionInput = {
  /** Where cloud-init's `write_files` puts the invitation, mode 0600. */
  tokenFile: string
  token: string
  /** Folders created as git repositories before any command runs. */
  repos: string[]
  /** `runcmd`, in order; each answers its exit code. */
  runcmd: Array<() => Promise<number>>
}

/** cloud-init user-data as the EC2 proof wrote it: `write_files`, the repos, then `runcmd`. */
export async function provision(input: ProvisionInput) {
  await fs.mkdir(path.dirname(input.tokenFile), { recursive: true, mode: 0o700 })
  await fs.writeFile(input.tokenFile, `${input.token}\n`, { mode: 0o600 })
  const tokenFileMode = (await fs.stat(input.tokenFile)).mode & 0o777
  for (const repo of input.repos) {
    await fs.mkdir(repo, { recursive: true })
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repo })
  }
  const exitCodes: number[] = []
  for (const command of input.runcmd) exitCodes.push(await command())
  return { tokenFileMode, exitCodes }
}
