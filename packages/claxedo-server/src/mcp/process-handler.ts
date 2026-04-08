/**
 * Process Handler — Consolidated process management
 *
 * Extracted handler logic for the unified `process` MCP tool.
 * Accepts factory functions for testability (dependency injection).
 */

import type { Process } from "../process/process"

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
  directory?: string
}

type ProcessConfig = Process.ProcessConfig
type ManagedProcess = Process.ManagedProcess
type LaunchResult = Process.LaunchResult
type ListResponse = Process.ListResponse

type HttpFn = (path: string, init?: RequestInit, mode?: "json" | "text", directory?: string) => Promise<any>

type ProcessClient = {
  list(init?: RequestInit): Promise<ListResponse>
  start(id: string): Promise<LaunchResult>
  stop(id: string): Promise<boolean>
  restart(id: string): Promise<LaunchResult>
  startAll(): Promise<boolean>
  stopAll(): Promise<boolean>
}

type ProcFactory = (directory?: string) => ProcessClient

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const clean = (value: unknown) => {
  if (typeof value !== "string") return ""
  return value.trim()
}

const errorResult = (text: string): ToolResult => ({
  content: [{ type: "text" as const, text }],
  isError: true,
})

const textResult = (text: string): ToolResult => ({
  content: [{ type: "text" as const, text }],
})

export const formatProcess = (config: ProcessConfig, proc?: ManagedProcess): string => {
  const status = proc?.status || "idle"
  const restart = proc && proc.restartCount > 0 ? ` (restarts: ${proc.restartCount})` : ""
  const exit = proc?.exitCode !== undefined ? ` exit=${proc.exitCode}` : ""
  const port = config.port ? ` [port: ${config.port.name}${proc?.assignedPort ? `=${proc.assignedPort}` : ""}]` : ""
  return `${config.name} (${config.id}): ${status}${exit}${restart}${port}\n  command: ${config.command}${config.args.length ? " " + config.args.join(" ") : ""}\n  restart: ${config.restartPolicy}, autoStart: ${config.autoStart}`
}

export const detail = (proc: ManagedProcess) => {
  const port = proc.assignedPort ? ` on port ${proc.assignedPort}` : ""
  return `${proc.status}${port}`
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
  return {
    text: `Process ${id} could not ${fail}: ${out.error}`,
    isError: true as const,
  }
}

// ---------------------------------------------------------------------------
// Exported handler
// ---------------------------------------------------------------------------

export async function handleProcess(
  args: ProcessInput,
  http: HttpFn,
  proc: ProcFactory,
  defaultDir: string,
): Promise<ToolResult> {
  const directory = clean(args.directory) || defaultDir
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

    case "start": {
      const id = clean(args.id)
      if (!id) return errorResult('action "start" requires "id" (process config ID).')
      const out = await proc(directory).start(id)
      const result = launch(id, out, "started", "start")
      return result.isError ? errorResult(result.text) : textResult(result.text)
    }

    case "stop": {
      const id = clean(args.id)
      if (!id) return errorResult('action "stop" requires "id" (process config ID).')
      await proc(directory).stop(id)
      return textResult(`Process ${id} stopped.`)
    }

    case "restart": {
      const id = clean(args.id)
      if (!id) return errorResult('action "restart" requires "id" (process config ID).')
      const out = await proc(directory).restart(id)
      const result = launch(id, out, "restarted", "restart")
      return result.isError ? errorResult(result.text) : textResult(result.text)
    }

    case "add": {
      const name = clean(args.name)
      const command = clean(args.command)
      if (!name) return errorResult('action "add" requires "name".')
      if (!command) return errorResult('action "add" requires "command".')
      const body: Record<string, unknown> = { name, command }
      if (args.args) body.args = args.args
      if (args.cwd) body.cwd = args.cwd
      if (args.env) body.env = args.env
      if (args.autoStart !== undefined) body.autoStart = args.autoStart
      if (args.restartPolicy) body.restartPolicy = args.restartPolicy
      if (args.maxRestarts !== undefined) body.maxRestarts = args.maxRestarts
      const config = await http(
        "/process",
        { method: "POST", body: JSON.stringify(body) },
        "json",
        directory,
      )
      return textResult(`Process config created: ${config.name} (${config.id})`)
    }

    case "update": {
      const id = clean(args.id)
      if (!id) return errorResult('action "update" requires "id" (process config ID).')
      const body: Record<string, unknown> = {}
      if (args.name) body.name = args.name
      if (args.command) body.command = args.command
      if (args.args) body.args = args.args
      if (args.cwd) body.cwd = args.cwd
      if (args.env) body.env = args.env
      if (args.autoStart !== undefined) body.autoStart = args.autoStart
      if (args.restartPolicy) body.restartPolicy = args.restartPolicy
      if (args.maxRestarts !== undefined) body.maxRestarts = args.maxRestarts
      const config = await http(
        `/process/${encodeURIComponent(id)}`,
        { method: "PUT", body: JSON.stringify(body) },
        "json",
        directory,
      )
      return textResult(`Process config updated: ${config.name} (${config.id})`)
    }

    case "remove": {
      const id = clean(args.id)
      if (!id) return errorResult('action "remove" requires "id" (process config ID).')
      await http(
        `/process/${encodeURIComponent(id)}`,
        { method: "DELETE" },
        "json",
        directory,
      )
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
      return errorResult(
        `Unknown action "${action}". Valid actions: list, start, stop, restart, add, update, remove, start_all, stop_all`,
      )
  }
}
