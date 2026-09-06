/**
 * Process Handler — Consolidated process management
 *
 * Extracted handler logic for the unified `process` MCP tool.
 * Accepts factory functions for testability (dependency injection).
 */

import { bool, num, oneOf, record, records, strings, stringRecord, text } from "./json"
import type { ControlPlaneRequest } from "./control-plane-request"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProcessAction =
  | "list"
  | "start"
  | "stop"
  | "restart"
  | "add"
  | "update"
  | "remove"
  | "start_all"
  | "stop_all"

export type ProcessPortInput = {
  name: string
  inject: string
  preferred?: number
  onConflict?: "pick-new" | "kill-existing"
}

export type ProcessInput = {
  action: ProcessAction
  id?: string
  name?: string
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  autoStart?: boolean
  restartPolicy?: "never" | "on-failure" | "always"
  maxRestarts?: number
  color?: string
  dependsOn?: string[]
  port?: ProcessPortInput
  directory?: string
  workspace_id?: string
}

type RestartPolicy = "never" | "on-failure" | "always"
type ProcessStatus = "idle" | "starting" | "running" | "stopping" | "stopped" | "crashed" | "restarting"

type ProcessConfig = {
  id: string
  name: string
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  autoStart: boolean
  restartPolicy: RestartPolicy
  maxRestarts: number
  color?: string
  dependsOn?: string[]
  port?: ProcessPortInput
}

type ManagedProcess = {
  configId: string
  ptyId?: string
  status: ProcessStatus
  restartCount: number
  exitCode?: number
  startedAt?: number
  exitedAt?: number
  assignedPort?: number
  namedUrl?: string
}

type PortConflictInfo = {
  type: "port-conflict"
  port: number
  pid?: number
  command?: string
  processName?: string
  processId?: string
  directory?: string
}

type RouteConflictInfo = {
  type: "route-conflict"
  hostname: string
  pid: number
  command?: string
  processName?: string
  processId?: string
  directory?: string
}

export type LaunchResult =
  | { kind: "started"; process: ManagedProcess }
  | { kind: "already_running"; process: ManagedProcess }
  | { kind: "port_conflict"; conflict: PortConflictInfo }
  | { kind: "route_conflict"; conflict: RouteConflictInfo }
  | { kind: "failed"; error: string; process?: ManagedProcess }
  | { kind: "not_found"; error: string }

export type ListResponse = {
  configs: ProcessConfig[]
  processes: ManagedProcess[]
}

// ---------------------------------------------------------------------------
// Reading the control plane's answers
//
// These bodies used to arrive through `httpRequest<ListResponse>` — a generic
// whose type argument was a wish, not a check. The parsers live next to the
// types they produce so there is one place to look when the route's shape
// changes, and one place a new field has to be added to become visible.
// ---------------------------------------------------------------------------

const RESTART_POLICIES: readonly RestartPolicy[] = ["never", "on-failure", "always"]
const PROCESS_STATUSES: readonly ProcessStatus[] = [
  "idle",
  "starting",
  "running",
  "stopping",
  "stopped",
  "crashed",
  "restarting",
]
const LAUNCH_KINDS = ["started", "already_running", "port_conflict", "route_conflict", "failed", "not_found"] as const

function parsePort(value: unknown): ProcessPortInput | undefined {
  const row = record(value)
  const name = text(row?.name)
  const inject = text(row?.inject)
  if (!row || !name || !inject) return undefined
  return {
    name,
    inject,
    preferred: num(row.preferred),
    onConflict: oneOf(row.onConflict, ["pick-new", "kill-existing"] as const),
  }
}

/**
 * A row with no id or name is dropped rather than rendered: `formatProcess`
 * keys processes to configs by id, and a nameless row can neither be displayed
 * nor acted on. This matches `configRow` below, which has always refused the
 * same shape on the add/update path.
 */
function parseProcessConfig(row: Record<string, unknown>): ProcessConfig | undefined {
  const id = text(row.id)
  const name = text(row.name)
  if (!id || !name) return undefined
  return {
    id,
    name,
    command: text(row.command) ?? "",
    args: strings(row.args),
    cwd: text(row.cwd),
    env: stringRecord(row.env),
    autoStart: bool(row.autoStart) ?? false,
    restartPolicy: oneOf(row.restartPolicy, RESTART_POLICIES) ?? "never",
    maxRestarts: num(row.maxRestarts) ?? 0,
    color: text(row.color),
    dependsOn: Array.isArray(row.dependsOn) ? strings(row.dependsOn) : undefined,
    port: parsePort(row.port),
  }
}

function parseManagedProcess(row: Record<string, unknown>): ManagedProcess | undefined {
  const configId = text(row.configId)
  if (!configId) return undefined
  return {
    configId,
    ptyId: text(row.ptyId),
    status: oneOf(row.status, PROCESS_STATUSES) ?? "idle",
    restartCount: num(row.restartCount) ?? 0,
    exitCode: num(row.exitCode),
    startedAt: num(row.startedAt),
    exitedAt: num(row.exitedAt),
    assignedPort: num(row.assignedPort),
    namedUrl: text(row.namedUrl),
  }
}

export function parseListResponse(value: unknown): ListResponse {
  const row = record(value)
  return {
    configs: records(row?.configs).flatMap((item) => parseProcessConfig(item) ?? []),
    processes: records(row?.processes).flatMap((item) => parseManagedProcess(item) ?? []),
  }
}

/**
 * Every unreadable answer becomes `failed` with a reason. The previous cast let
 * a `started` body with no `process` reach `detail(out.process)`, which threw a
 * TypeError out of the tool instead of reporting what the server actually said.
 */
export function parseLaunchResult(value: unknown): LaunchResult {
  const row = record(value)
  const kind = oneOf(row?.kind, LAUNCH_KINDS)
  if (!row || !kind) {
    return { kind: "failed", error: `Unrecognized launch response kind ${JSON.stringify(row?.kind ?? null)}` }
  }

  if (kind === "started" || kind === "already_running") {
    const managed = record(row.process)
    const parsed = managed ? parseManagedProcess(managed) : undefined
    if (!parsed) return { kind: "failed", error: `Launch reported "${kind}" without a process` }
    return { kind, process: parsed }
  }

  if (kind === "port_conflict") {
    const conflict = record(row.conflict)
    const port = num(conflict?.port)
    if (!conflict || port === undefined) return { kind: "failed", error: "Port conflict reported without a port" }
    return {
      kind,
      conflict: {
        type: "port-conflict",
        port,
        pid: num(conflict.pid),
        command: text(conflict.command),
        processName: text(conflict.processName),
        processId: text(conflict.processId),
        directory: text(conflict.directory),
      },
    }
  }

  if (kind === "route_conflict") {
    const conflict = record(row.conflict)
    const hostname = text(conflict?.hostname)
    const pid = num(conflict?.pid)
    if (!conflict || !hostname || pid === undefined) {
      return { kind: "failed", error: "Route conflict reported without a hostname and pid" }
    }
    return {
      kind,
      conflict: {
        type: "route-conflict",
        hostname,
        pid,
        command: text(conflict.command),
        processName: text(conflict.processName),
        processId: text(conflict.processId),
        directory: text(conflict.directory),
      },
    }
  }

  if (kind === "not_found") return { kind, error: text(row.error) ?? "not found" }

  const managed = record(row.process)
  return {
    kind: "failed",
    error: text(row.error) ?? "unknown error",
    process: managed ? parseManagedProcess(managed) : undefined,
  }
}

export type ProcessClient = {
  list(init?: RequestInit): Promise<ListResponse>
  start(id: string): Promise<LaunchResult>
  /**
   * `stop`, `startAll` and `stopAll` used to return a boolean no caller read —
   * and could not have read usefully: the control plane answers these with an
   * empty body, which the JSON reader turns into `null`, so the old
   * `value === undefined || value === true` was false on every success. The
   * handler already reports the action as done regardless; the honest signature
   * is the one that promises nothing about the outcome.
   */
  stop(id: string): Promise<void>
  restart(id: string): Promise<LaunchResult>
  startAll(): Promise<void>
  stopAll(): Promise<void>
}

type ProcFactory = (directory?: string) => ProcessClient

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROCESS_PATH = "/api/wr/process"

const clean = (value: unknown) => {
  if (typeof value !== "string") return ""
  return value.trim()
}

const workspaceRef = (id: string) => `workspace:${id}`

const rec = record

const configRow = (value: unknown) => {
  const row = rec(value)
  const id = clean(row?.id)
  const name = clean(row?.name)
  if (!id || !name) throw new Error("Process config response missing id or name")
  return { id, name }
}

const errorResult = (text: string): ToolResult => ({
  content: [{ type: "text" as const, text }],
  isError: true,
})

const textResult = (text: string): ToolResult => ({
  content: [{ type: "text" as const, text }],
})

function createProcessId() {
  const now = Date.now()
  const hex = now.toString(16).padStart(12, "0")
  const rand = Math.random().toString(36).slice(2, 16)
  return `proc_${hex}${rand}`
}

export const formatProcess = (config: ProcessConfig, proc?: ManagedProcess): string => {
  const status = proc?.status || "idle"
  const restart = proc && proc.restartCount > 0 ? ` (restarts: ${proc.restartCount})` : ""
  const exit = proc?.exitCode !== undefined ? ` exit=${proc.exitCode}` : ""
  const port = config.port ? ` [port: ${config.port.name}${proc?.assignedPort ? `=${proc.assignedPort}` : ""}]` : ""
  const url = proc?.namedUrl ? `\n  url: ${proc.namedUrl}` : ""
  return `${config.name} (${config.id}): ${status}${exit}${restart}${port}\n  command: ${config.command}${config.args.length ? " " + config.args.join(" ") : ""}\n  restart: ${config.restartPolicy}, autoStart: ${config.autoStart}${url}`
}

export const detail = (proc: ManagedProcess) => {
  const port = proc.assignedPort ? ` on port ${proc.assignedPort}` : ""
  const url = proc.namedUrl ? ` (${proc.namedUrl})` : ""
  return `${proc.status}${port}${url}`
}

export const launch = (id: string, out: LaunchResult, ok: string, fail: string) => {
  if (out.kind === "started") {
    return { text: `Process ${id} ${ok}. Status: ${detail(out.process)}` }
  }
  if (out.kind === "already_running") {
    return { text: `Process ${id} is already running. Status: ${detail(out.process)}` }
  }
  if (out.kind === "port_conflict") {
    const owner = out.conflict.processName ? ` (${out.conflict.processName})` : ""
    return {
      text: `Process ${id} could not ${fail}: preferred port ${out.conflict.port} is in use${owner}.`,
      isError: true as const,
    }
  }
  if (out.kind === "route_conflict") {
    const owner = out.conflict.processName ? ` (${out.conflict.processName})` : ""
    return {
      text: `Process ${id} could not ${fail}: route ${out.conflict.hostname} is in use${owner}.`,
      isError: true as const,
    }
  }
  return {
    text: `Process ${id} could not ${fail}: ${out.error}`,
    isError: true as const,
  }
}

// ---------------------------------------------------------------------------
// Exported handler
// ---------------------------------------------------------------------------

function processConfigOptions(args: ProcessInput) {
  const body: Record<string, unknown> = {}
  if (args.args) body.args = args.args
  if (args.cwd) body.cwd = args.cwd
  if (args.env) body.env = args.env
  if (args.autoStart !== undefined) body.autoStart = args.autoStart
  if (args.restartPolicy) body.restartPolicy = args.restartPolicy
  if (args.maxRestarts !== undefined) body.maxRestarts = args.maxRestarts
  if (args.color) body.color = args.color
  if (args.dependsOn) body.dependsOn = args.dependsOn
  if (args.port) body.port = args.port
  return body
}

export async function handleProcess(
  args: ProcessInput,
  http: ControlPlaneRequest,
  proc: ProcFactory,
  defaultDir: string,
): Promise<ToolResult> {
  const directory = clean(args.directory) || (clean(args.workspace_id) ? workspaceRef(clean(args.workspace_id)) : defaultDir)
  const { action } = args

  switch (action) {
    case "list": {
      const data = await proc(directory).list()
      if (!data.configs.length) {
        return textResult("No processes configured.")
      }
      const lines = data.configs.map((config) => {
        const p = data.processes.find((p) => p.configId === config.id)
        return formatProcess(config, p)
      })
      return textResult(lines.join("\n\n"))
    }

    case "start":
    case "restart": {
      const id = clean(args.id)
      if (!id) return errorResult(`action "${action}" requires "id" (process config ID).`)
      const out = await proc(directory)[action](id)
      const result = launch(id, out, action === "start" ? "started" : "restarted", action)
      return result.isError ? errorResult(result.text) : textResult(result.text)
    }

    case "stop": {
      const id = clean(args.id)
      if (!id) return errorResult('action "stop" requires "id" (process config ID).')
      await proc(directory).stop(id)
      return textResult(`Process ${id} stopped.`)
    }

    case "add": {
      const name = clean(args.name)
      const command = clean(args.command)
      if (!name) return errorResult('action "add" requires "name".')
      if (!command) return errorResult('action "add" requires "command".')
      const body: Record<string, unknown> = { id: clean(args.id) || createProcessId(), name, command }
      Object.assign(body, processConfigOptions(args))
      const config = configRow(await http(PROCESS_PATH, { method: "POST", body: JSON.stringify(body) }, directory))
      return textResult(`Process config created: ${config.name} (${config.id})`)
    }

    case "update": {
      const id = clean(args.id)
      if (!id) return errorResult('action "update" requires "id" (process config ID).')
      const body: Record<string, unknown> = {}
      if (args.name) body.name = args.name
      if (args.command) body.command = args.command
      Object.assign(body, processConfigOptions(args))
      const config = configRow(await http(`${PROCESS_PATH}/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }, directory))
      return textResult(`Process config updated: ${config.name} (${config.id})`)
    }

    case "remove": {
      const id = clean(args.id)
      if (!id) return errorResult('action "remove" requires "id" (process config ID).')
      await http(`${PROCESS_PATH}/${encodeURIComponent(id)}`, { method: "DELETE" }, directory)
      return textResult(`Process config ${id} removed.`)
    }

    case "start_all": {
      await proc(directory).startAll()
      return textResult("All autoStart processes started.")
    }

    case "stop_all": {
      await proc(directory).stopAll()
      return textResult("All processes stopped.")
    }

    default:
      // `action` is `never` here: the switch covers every ProcessAction, so a
      // value reaching this arm escaped the declared union at runtime.
      return errorResult(
        `Unknown action ${JSON.stringify(action)}. Valid actions: list, start, stop, restart, add, update, remove, start_all, stop_all`,
      )
  }
}
