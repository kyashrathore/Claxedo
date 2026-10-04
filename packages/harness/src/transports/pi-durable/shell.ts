import { once } from "node:events"
import { existsSync } from "node:fs"
import path from "node:path"
import { errorMessage } from "@claxedo/helpers"
import type { Context } from "@earendil-works/chord"
import { ExecutionError, type ExecutionEnv, type Result, type ShellExecOptions, type ShellExecResult } from "@earendil-works/pi-durable/env"
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node"
import { deadlineAfter, type HarnessServices, type OwnedProcess } from "../../contract/node"
import { exitMarker, type ExitMarker } from "./exit-marker"

const SHELL = existsSync("/bin/bash") ? "/bin/bash" : "bash"
const SCRIPT = `eval "$1"
printf '%s%d\\n' "$2" "$?" >&2
wait`
const EXIT_STDIO_GRACE_MS = 2_000
const RETIRE_MS = 5_000

export type PiShellServices = Pick<HarnessServices, "spawn" | "clock" | "log">

export type LiveProcesses = { add(owned: OwnedProcess): unknown; delete(owned: OwnedProcess): unknown }

export type PiShellHost = { sessionId: string; services: PiShellServices; env: Readonly<Record<string, string>>; live: LiveProcesses }

type Exec = { owned: OwnedProcess; options: ShellExecOptions | undefined; context: Context; marker: ExitMarker; settled: boolean;
  drained: Promise<void> }

const execFailure = (code: ExecutionError["code"], message: string): Result<ShellExecResult, ExecutionError> =>
  ({ ok: false, error: new ExecutionError(code, message) })

function forward(exec: Exec): void {
  const emit = (text: string) => { if (text && !exec.settled) exec.options?.onOutput?.(text, exec.context) }
  const stdout = new TextDecoder()
  const stderr = new TextDecoder()
  exec.owned.stdout.on("data", (chunk: Uint8Array) => emit(stdout.decode(chunk, { stream: true })))
  exec.owned.stderr.on("data", (chunk: Uint8Array) => emit(exec.marker.filter(stderr.decode(chunk, { stream: true }))))
}

async function exitCode(exec: Exec, grace: () => Promise<void>): Promise<number> {
  const code = await Promise.race([exec.marker.code, exec.owned.exited.then((exit) => exit.code ?? 1)])
  await grace()
  return code
}

function retireWhenExited(host: PiShellHost, owned: OwnedProcess): void {
  host.live.add(owned)
  void owned.exited.then(async () => {
    host.live.delete(owned)
    await owned.retire(deadlineAfter(host.services.clock, RETIRE_MS))
  }).then(undefined, (error: unknown) => host.services.log.error("Pi bash retirement failed", { error: errorMessage(error) }))
}

async function settleExec(host: PiShellHost, exec: Exec): Promise<Result<ShellExecResult, ExecutionError>> {
  const { clock } = host.services
  let stopped: "aborted" | "timeout" | undefined
  const stop = (reason: "aborted" | "timeout") => { stopped ??= reason; void exec.owned.retire(deadlineAfter(clock, RETIRE_MS)) }
  const onAbort = () => stop("aborted")
  exec.context.abortSignal?.addEventListener("abort", onAbort, { once: true })
  const seconds = exec.options?.timeout
  const timer = seconds === undefined ? undefined : clock.setTimeout(() => stop("timeout"), seconds * 1000)
  const grace = () => Promise.race([exec.drained,
    new Promise<void>((resolve) => { clock.setTimeout(() => resolve(), EXIT_STDIO_GRACE_MS) })])
  try {
    const code = await exitCode(exec, grace)
    if (stopped) return execFailure(stopped, stopped === "timeout" ? `Command timed out after ${seconds} seconds` : "Command aborted")
    return { ok: true, value: { exitCode: code } }
  } finally {
    exec.settled = true
    clock.clearTimeout(timer)
    exec.context.abortSignal?.removeEventListener("abort", onAbort)
    if (stopped) await exec.owned.retire(deadlineAfter(clock, RETIRE_MS))
    else retireWhenExited(host, exec.owned)
  }
}

async function ownedExec(host: PiShellHost, cwd: string, command: string, options: ShellExecOptions | undefined,
  context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
  if (context.abortSignal?.aborted) return execFailure("aborted", "aborted")
  if (options?.timeout !== undefined && !(Number.isFinite(options.timeout) && options.timeout > 0)) {
    return execFailure("timeout", "Invalid timeout: must be a finite number of seconds")
  }
  const env = options?.inheritEnv === false ? { ...options.env } : { ...host.env, ...options?.env }
  const marker = exitMarker()
  let owned: OwnedProcess
  try {
    owned = await host.services.spawn({ file: SHELL, args: ["-c", SCRIPT, "pi-bash", command, marker.text],
      cwd: options?.cwd ? path.resolve(cwd, options.cwd) : cwd, env },
    { role: "harness", label: "Pi bash", sessionId: host.sessionId, signal: context.abortSignal ?? new AbortController().signal })
  } catch (error) {
    return execFailure("spawn_error", errorMessage(error))
  }
  owned.stdin.end()
  const drained = Promise.all([once(owned.stdout, "close"), once(owned.stderr, "close")])
    .then(() => undefined, (error: unknown) => host.services.log.warn("Pi bash output stream failed", { error: errorMessage(error) }))
  const exec = { owned, options, context, marker, settled: false, drained }
  forward(exec)
  return settleExec(host, exec)
}

export function sessionCommands(services: PiShellServices) {
  const live = new Map<string, Set<OwnedProcess>>()
  const of = (sessionId: string): LiveProcesses => ({
    add: (owned) => live.get(sessionId)?.add(owned) ?? live.set(sessionId, new Set([owned])),
    delete: (owned) => {
      const running = live.get(sessionId)
      running?.delete(owned)
      if (running?.size === 0) live.delete(sessionId)
    },
  })
  const retire = async (sessionId: string): Promise<void> => {
    const running = [...live.get(sessionId) ?? []]
    live.delete(sessionId)
    await Promise.all(running.map((owned) => owned.retire(deadlineAfter(services.clock, RETIRE_MS))))
  }
  return { of, retire, sessions: () => [...live.keys()], retireAll: async () => { await Promise.all([...live.keys()].map(retire)) } }
}

export function ownedExecutionEnv(host: PiShellHost, cwd: string): ExecutionEnv {
  const env = new NodeExecutionEnv({ cwd, shellEnv: host.env })
  return Object.assign(env, { exec: (command: string, options: ShellExecOptions | undefined, context: Context) =>
    ownedExec(host, env.cwd, command, options, context) })
}
