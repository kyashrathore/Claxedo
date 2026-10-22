import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { piBashPath } from "@claxedo/harness/pi-durable/shell"
import { withDeadlineSignal } from "@claxedo/helpers/deadline"
import { isMissingFile } from "@claxedo/helpers/fs"
import { asRecordOrEmpty } from "@claxedo/helpers/guards"
import type { HostState } from "@claxedo/host-connector/host-state"
import { installedTerminalAgents, type TerminalAgentId } from "@claxedo/workspace-runtime"
import { config } from "../config"
import { connectPaths, connectStateStore } from "../connect/paths"
import { defaultServiceDeps, LAUNCHD_LABEL, launchdDomain, linuxUserManager, SYSTEMD_UNIT, unitSetsPath, type ServiceDeps } from "../connect/service"
import { WINDOWS_TASK, windowsTaskStatus } from "../connect/service-windows"
import { hostOnline, processAlive } from "./status"

export type CheckLevel = "ok" | "info" | "warn" | "fail"

export type Check = { level: CheckLevel; line: string }

export type HealthAnswer = { status: number; body: unknown }

export type DoctorDeps = {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  home: string
  nodeVersion: string
  stateFile: string
  load: () => Promise<HostState | undefined>
  /** `undefined` when the file does not exist. */
  readFile: (file: string) => Promise<string | undefined>
  exists: (file: string) => boolean
  /** The whole answer, body read, within the probe's own deadline; rejects past it. */
  probe: (url: string) => Promise<HealthAnswer>
  service: ServiceDeps
  pidAlive: (pid: number) => boolean
  now: () => number
  log: (line: string) => void
}

const MINIMUM_NODE_MAJOR = 24
const PROBE_TIMEOUT_MS = 10_000

export function defaultDoctorDeps(): DoctorDeps {
  return {
    platform: process.platform,
    env: process.env,
    home: os.homedir(),
    nodeVersion: process.versions.node,
    stateFile: connectPaths().stateFile,
    load: () => connectStateStore().load(),
    readFile: (file) => fs.readFile(file, "utf8").catch((error: unknown) => {
      if (isMissingFile(error)) return undefined
      throw error
    }),
    exists: existsSync,
    probe: (url) => withDeadlineSignal(PROBE_TIMEOUT_MS, async (signal) => {
      const response = await fetch(url, { signal, redirect: "manual" })
      return { status: response.status, body: healthBody(await response.text()) }
    }),
    service: defaultServiceDeps(),
    pidAlive: processAlive,
    now: () => Date.now(),
    log: (line) => console.log(line),
  }
}

function healthBody(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function nodeCheck(deps: DoctorDeps): Check {
  const major = Number(deps.nodeVersion.split(".")[0])
  if (major >= MINIMUM_NODE_MAJOR) return { level: "ok", line: `Node ${deps.nodeVersion}` }
  return { level: "fail", line: `Node ${deps.nodeVersion} is older than the ${MINIMUM_NODE_MAJOR} claxedo needs; install Node ${MINIMUM_NODE_MAJOR}, or rerun install.sh, which brings its own` }
}

function reasonOf(error: unknown) {
  if (error instanceof Error && error.name === "TimeoutError") return `no answer in ${PROBE_TIMEOUT_MS / 1000} s`
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined
  return cause ?? (error instanceof Error ? error.message : String(error))
}

async function answers(deps: DoctorDeps, url: string, healthy: (body: Record<string, unknown>) => boolean) {
  const started = deps.now()
  try {
    const answer = await deps.probe(`${url.replace(/\/+$/, "")}/health`)
    if (answer.status < 200 || answer.status > 299) return { answered: false as const, reason: `it answered ${answer.status}` }
    if (!healthy(asRecordOrEmpty(answer.body))) return { answered: false as const, reason: "its health answer is not Claxedo's" }
    return { answered: true as const, ms: deps.now() - started }
  } catch (error) {
    return { answered: false as const, reason: reasonOf(error) }
  }
}

async function controlPlaneChecks(deps: DoctorDeps, state: HostState | undefined): Promise<Check[]> {
  const managedFrom = config(deps.env).controlPlaneUrl
  const url = state?.control_plane_url ?? managedFrom
  const probed = await answers(deps, url, (body) => body.status === "ok")
  const checks: Check[] = [probed.answered
    ? { level: "ok", line: `Control plane ${url} answers in ${probed.ms} ms` }
    : { level: "fail", line: `Control plane ${url} cannot be reached (${probed.reason}); check this machine's network or proxy` }]
  if (state && state.control_plane_url !== managedFrom) {
    checks.push({
      level: "warn",
      line: `This machine is enrolled with ${state.control_plane_url}, but \`claxedo host\` here talks to ${managedFrom}; set CLAXEDO_CONTROL_PLANE_URL=${state.control_plane_url} to manage it from here`,
    })
  }
  return checks
}

async function relayCheck(deps: DoctorDeps, state: HostState | undefined): Promise<Check> {
  if (!state?.relay) return { level: "info", line: "Relay: this machine learns its relay when it enrolls" }
  const probed = await answers(deps, state.relay.url, (body) => body.ok === true && body.service === "workspace-relay")
  return probed.answered
    ? { level: "ok", line: `Relay ${state.relay.url} answers in ${probed.ms} ms` }
    : { level: "fail", line: `Relay ${state.relay.url} cannot be reached (${probed.reason}); other devices cannot reach this machine's folders` }
}

function enrollmentCheck(deps: DoctorDeps, state: HostState | undefined): Check {
  if (state?.bootstrap) return { level: "fail", line: "The invitation was not redeemed to the end; run the same `claxedo connect <invitation>` again" }
  if (!state?.enrollment) return { level: "info", line: "Not connected yet: `claxedo connect <invitation>` enrolls this machine" }
  if (state.run?.paused_at !== undefined) return { level: "info", line: "Paused by the owner: nothing is served until the owner resumes this machine in the app" }
  if (hostOnline(state, deps)) {
    const ago = Math.max(0, Math.round((deps.now() - (state.run?.last_beat_ok_at ?? deps.now())) / 1000))
    return { level: "ok", line: `Connected; the last beat was ${ago} s ago` }
  }
  if (state.run?.last_beat_error) return { level: "fail", line: `Not serving: ${state.run.last_beat_error}` }
  return { level: "fail", line: "Not serving: connect is not running; start it with `claxedo connect` or its service" }
}

async function serviceRunning(deps: DoctorDeps, service: NonNullable<HostState["service"]>): Promise<Check> {
  const run = deps.service.run
  if (service.kind === "systemd-user") {
    const manager = await linuxUserManager(deps.service)
    if (!manager.reachable) return { level: "fail", line: `${SYSTEMD_UNIT} cannot run: ${manager.reason}; run \`${manager.remedy[0]}\`` }
    const active = (await run("systemctl", ["--user", "is-active", SYSTEMD_UNIT])).stdout.trim() || "unknown"
    return active === "active"
      ? { level: "ok", line: `Service ${SYSTEMD_UNIT} is running` }
      : { level: "fail", line: `Service ${SYSTEMD_UNIT} is ${active}; \`journalctl --user -u ${SYSTEMD_UNIT}\` says why` }
  }
  if (service.kind === "launchd") {
    const printed = await run("launchctl", ["print", `${launchdDomain()}/${LAUNCHD_LABEL}`])
    if (printed.code !== 0) return { level: "fail", line: `Service ${LAUNCHD_LABEL} is not loaded; \`launchctl bootstrap gui/$(id -u) ${service.unit}\` loads it` }
    const state = /^\s*state = (\S+)/m.exec(printed.stdout)?.[1] ?? "unknown"
    return state === "running"
      ? { level: "ok", line: `Service ${LAUNCHD_LABEL} is running` }
      : { level: "warn", line: `Service ${LAUNCHD_LABEL} is loaded but ${state}` }
  }
  const status = windowsTaskStatus((await run("schtasks.exe", ["/Query", "/TN", WINDOWS_TASK, "/FO", "CSV", "/NH"])).stdout)
  return status === "Running"
    ? { level: "ok", line: `Scheduled task ${WINDOWS_TASK} is running` }
    : { level: "warn", line: `Scheduled task ${WINDOWS_TASK} is ${status}; it starts at ${deps.service.username}'s next logon` }
}

async function serviceChecks(deps: DoctorDeps, state: HostState | undefined): Promise<Check[]> {
  const service = state?.service
  if (!service) return [{ level: "info", line: "No service: connect runs only while its terminal is open; `claxedo connect --install-service` keeps it running" }]
  const unit = await deps.readFile(service.unit)
  if (unit === undefined) return [{ level: "fail", line: `The service file ${service.unit} is gone; \`claxedo connect --install-service\` writes it again` }]
  const checks = [await serviceRunning(deps, service)]
  if (!unitSetsPath(service.kind, unit)) {
    checks.push({
      level: "warn",
      line: "The service runs without your shell's PATH, so it may not find codex or the tools agents run; `claxedo connect --install-service` writes it again",
    })
  }
  return checks
}

async function gitCheck(deps: DoctorDeps): Promise<Check> {
  const version = await deps.service.run("git", ["--version"])
  return version.code === 0
    ? { level: "ok", line: version.stdout.trim() }
    : { level: "fail", line: "git is not on PATH, so this machine cannot clone repositories or make worktrees" }
}

const AGENT_NAMES: Record<TerminalAgentId, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" }

function agentsCheck(deps: DoctorDeps): Check {
  const found = installedTerminalAgents(deps.env, deps.home).map((id) => AGENT_NAMES[id])
  return found.length
    ? { level: "ok", line: `Agent CLIs: ${found.join(", ")}` }
    : { level: "info", line: "No Claude Code, Codex or Cursor CLI found; sessions here run on Pi" }
}

function isWslLauncher(file: string) {
  return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/i.test(path.win32.normalize(file))
}

async function windowsBashCheck(deps: DoctorDeps): Promise<Check | undefined> {
  if (deps.platform !== "win32") return undefined
  const bash = piBashPath(deps.platform, deps.env, deps.exists)
  if (bash !== "bash") return { level: "ok", line: `Git Bash ${bash}` }
  const found = (await deps.service.run("where.exe", ["bash.exe"])).stdout.split(/\r?\n/)[0]?.trim()
  if (!found) return { level: "fail", line: "Git Bash is not installed, so Pi cannot run commands; install Git for Windows" }
  if (isWslLauncher(found)) return { level: "warn", line: "Only WSL's bash is on PATH, so Pi would run its commands inside WSL; install Git for Windows" }
  return { level: "ok", line: `bash ${found}` }
}

export async function doctorChecks(deps: DoctorDeps): Promise<Check[]> {
  const state = await deps.load()
  const [controlPlane, relay, service, git, bash] = await Promise.all([
    controlPlaneChecks(deps, state),
    relayCheck(deps, state),
    serviceChecks(deps, state),
    gitCheck(deps),
    windowsBashCheck(deps),
  ])
  return [
    nodeCheck(deps),
    ...controlPlane,
    relay,
    enrollmentCheck(deps, state),
    ...service,
    git,
    agentsCheck(deps),
    ...(bash ? [bash] : []),
  ]
}

/** One line per check; exits 1 when any check failed. */
export async function doctor(deps: DoctorDeps = defaultDoctorDeps()): Promise<number> {
  const checks = await doctorChecks(deps)
  for (const check of checks) deps.log(`${check.level.padEnd(4)}  ${check.line}`)
  return checks.some((check) => check.level === "fail") ? 1 : 0
}
