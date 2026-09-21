/**
 * The workspace's managed processes: what is configured, what is running, and
 * the output of one of them.
 *
 * The runtime assigns ports and owns restart policy, so these tools carry no
 * lifecycle opinion of their own; they name a process and report what the
 * manager answers, including the refusals — a port already in use is a result
 * the model can act on, not an exception.
 */
import { z } from "zod"
import { WorkspaceRuntimeClientError } from "@claxedo/workspace-runtime/client"
import { bool, num, oneOf, record, records, strings, stringRecord, text } from "../json"
import type { ToolRegistrar } from "./registry"
import { declaredToolAccess } from "./inventory"
import { assertWritableTarget, toolJson, toolTarget, toolText, WORKSPACE_TARGET_SCHEMA } from "./target"

type RestartPolicy = "never" | "on-failure" | "always"
type ProcessStatus = "idle" | "starting" | "running" | "stopping" | "stopped" | "crashed" | "restarting"

type ProcessPort = {
  name: string
  inject: string
  preferred?: number
  onConflict?: "pick-new" | "kill-existing"
}

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
  port?: ProcessPort
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

type PortConflict = {
  type: "port-conflict"
  port: number
  pid?: number
  command?: string
  processName?: string
  processId?: string
  directory?: string
}

type RouteConflict = {
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
  | { kind: "port_conflict"; conflict: PortConflict }
  | { kind: "route_conflict"; conflict: RouteConflict }
  | { kind: "failed"; error: string; process?: ManagedProcess }
  | { kind: "not_found"; error: string }

export type ListResponse = {
  configs: ProcessConfig[]
  processes: ManagedProcess[]
}

const RESTART_POLICIES: readonly RestartPolicy[] = ["never", "on-failure", "always"]
const PROCESS_STATUSES: readonly ProcessStatus[] = ["idle", "starting", "running", "stopping", "stopped", "crashed", "restarting"]
const LAUNCH_KINDS = ["started", "already_running", "port_conflict", "route_conflict", "failed", "not_found"] as const

function parsePort(value: unknown): ProcessPort | undefined {
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
 * A row with no id or name is dropped rather than rendered: processes are
 * keyed to configs by id, and a nameless row can neither be displayed nor
 * acted on.
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
 * Every unreadable answer becomes `failed` with a reason, so a `started` body
 * with no process is reported rather than thrown at a caller that would then
 * read a property of undefined.
 */
export function parseLaunchResult(value: unknown): LaunchResult {
  const row = record(value)
  const kind = oneOf(row?.kind, LAUNCH_KINDS)
  if (!row || !kind) return { kind: "failed", error: `Unrecognized launch response kind ${JSON.stringify(row?.kind ?? null)}` }

  if (kind === "started" || kind === "already_running") {
    const parsed = parseManagedProcess(record(row.process) ?? {})
    if (!parsed) return { kind: "failed", error: `Launch reported "${kind}" without a process` }
    return { kind, process: parsed }
  }

  if (kind === "port_conflict") {
    const conflict = record(row.conflict)
    const port = num(conflict?.port)
    if (!conflict || port === undefined) return { kind: "failed", error: "Port conflict reported without a port" }
    return { kind, conflict: { type: "port-conflict", port, ...conflictOwner(conflict) } }
  }

  if (kind === "route_conflict") {
    const conflict = record(row.conflict)
    const hostname = text(conflict?.hostname)
    const pid = num(conflict?.pid)
    if (!conflict || !hostname || pid === undefined) return { kind: "failed", error: "Route conflict reported without a hostname and pid" }
    return { kind, conflict: { type: "route-conflict", hostname, ...conflictOwner(conflict), pid } }
  }

  if (kind === "not_found") return { kind, error: text(row.error) ?? "not found" }

  const managed = record(row.process)
  return {
    kind: "failed",
    error: text(row.error) ?? "unknown error",
    process: managed ? parseManagedProcess(managed) : undefined,
  }
}

function conflictOwner(conflict: Record<string, unknown>) {
  return {
    pid: num(conflict.pid),
    command: text(conflict.command),
    processName: text(conflict.processName),
    processId: text(conflict.processId),
    directory: text(conflict.directory),
  }
}

export function formatProcess(config: ProcessConfig, managed?: ManagedProcess): string {
  const status = managed?.status ?? "idle"
  const restart = managed && managed.restartCount > 0 ? ` (restarts: ${managed.restartCount})` : ""
  const exit = managed?.exitCode !== undefined ? ` exit=${managed.exitCode}` : ""
  const port = config.port ? ` [port: ${config.port.name}${managed?.assignedPort ? `=${managed.assignedPort}` : ""}]` : ""
  const url = managed?.namedUrl ? `\n  url: ${managed.namedUrl}` : ""
  const args = config.args.length ? ` ${config.args.join(" ")}` : ""
  return `${config.name} (${config.id}): ${status}${exit}${restart}${port}\n  command: ${config.command}${args}\n  restart: ${config.restartPolicy}, autoStart: ${config.autoStart}${url}`
}

export function processDetail(managed: ManagedProcess): string {
  const port = managed.assignedPort ? ` on port ${managed.assignedPort}` : ""
  const url = managed.namedUrl ? ` (${managed.namedUrl})` : ""
  return `${managed.status}${port}${url}`
}

export function launchText(id: string, result: LaunchResult): { text: string; isError?: true } {
  if (result.kind === "started") return { text: `Process ${id} started. Status: ${processDetail(result.process)}` }
  if (result.kind === "already_running") return { text: `Process ${id} is already running. Status: ${processDetail(result.process)}` }
  if (result.kind === "port_conflict") {
    const owner = result.conflict.processName ? ` (${result.conflict.processName})` : ""
    return { text: `Process ${id} could not start: preferred port ${result.conflict.port} is in use${owner}.`, isError: true }
  }
  if (result.kind === "route_conflict") {
    const owner = result.conflict.processName ? ` (${result.conflict.processName})` : ""
    return { text: `Process ${id} could not start: route ${result.conflict.hostname} is in use${owner}.`, isError: true }
  }
  return { text: `Process ${id} could not start: ${result.error}`, isError: true }
}

const PROCESS_ARG = { process: z.string().trim().min(1).describe("Process config id.") } as const

export function registerProcessTools(registry: ToolRegistrar) {
  registry.tool(
    "processes",
    {
      description: "List the workspace's configured processes with the status, assigned port and URL of each one that is running.",
      inputSchema: { ...WORKSPACE_TARGET_SCHEMA },
      access: declaredToolAccess({ audiences: ["runtime", "user"], write: false, scope: "read" }),
    },
    async (args, ctx) => {
      const server = await ctx.client.server(toolTarget(ctx, args))
      const listed = parseListResponse(await server.process.list())
      if (listed.configs.length === 0) return toolText("No processes are configured in this workspace.")
      return toolText(
        listed.configs
          .map((config) => formatProcess(config, listed.processes.find((managed) => managed.configId === config.id)))
          .join("\n\n"),
      )
    },
  )

  registry.tool(
    "process_start",
    {
      description: "Start a configured process. The workspace assigns its ports; a port or route already in use is reported rather than taken.",
      inputSchema: { ...PROCESS_ARG, ...WORKSPACE_TARGET_SCHEMA },
      access: declaredToolAccess({ audiences: ["runtime", "user"], write: true, scope: "act" }),
    },
    async (args, ctx) => {
      const target = toolTarget(ctx, args)
      assertWritableTarget(ctx, "process_start", target)
      const server = await ctx.client.server(target)
      // A refusal the manager states — an unknown config, a taken port — rides
      // its own status code, so the failing launch body is read rather than
      // thrown away as a transport error.
      const answered = await server.process
        .start(args.process)
        .catch((error: unknown) => launchFailureBody(error))
      const result = launchText(args.process, parseLaunchResult(answered))
      return { content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true } : {}) }
    },
  )

  registry.tool(
    "process_stop",
    {
      description:
        "Stop a running process and report what stopping it reached: `stopped` when the workspace proved it gone, `unresolved` when it did not, with the retirement evidence behind that answer. An unresolved stop leaves the process running and its port held.",
      inputSchema: { ...PROCESS_ARG, ...WORKSPACE_TARGET_SCHEMA },
      access: declaredToolAccess({ audiences: ["runtime", "user"], write: true, scope: "act" }),
    },
    async (args, ctx) => {
      const target = toolTarget(ctx, args)
      assertWritableTarget(ctx, "process_stop", target)
      const server = await ctx.client.server(target)
      const { state, retirement } = await server.process.stop(args.process)
      return {
        ...toolJson({ process: args.process, state, retirement: retirement ?? null }),
        ...(state === "unresolved" ? { isError: true } : {}),
      }
    },
  )

  registry.tool(
    "process_logs",
    {
      description: "Read the tail of one process's output.",
      inputSchema: {
        ...WORKSPACE_TARGET_SCHEMA,
        process: z.string().trim().min(1).optional().describe("Process config id."),
        name: z.string().trim().min(1).optional().describe("Process name, when the id is not to hand."),
        lines: z.number().int().min(1).max(10_000).optional().describe("Lines from the end. Defaults to 100."),
      },
      access: declaredToolAccess({ audiences: ["runtime", "user"], write: false, scope: "read" }),
    },
    async (args, ctx) => {
      const server = await ctx.client.server(toolTarget(ctx, args))
      const logs = await server.process.logs({
        ...(args.process ? { process_id: args.process } : {}),
        ...(args.name ? { name: args.name } : {}),
        ...(args.lines ? { lines: String(args.lines) } : {}),
      })
      return toolText(logs.length > 0 ? logs : "The process has produced no output yet.")
    },
  )
}

/** The body of a launch the runtime refused; anything else is a transport failure and stays thrown. */
function launchFailureBody(error: unknown): unknown {
  if (error instanceof WorkspaceRuntimeClientError && record(error.body)?.kind !== undefined) return error.body
  throw error
}
