import { existsSync } from "node:fs"
import path from "node:path"
import type { Readable } from "node:stream"
import { errorMessage } from "@claxedo/helpers"
import type { Context } from "@earendil-works/chord"
import { ExecutionError, type ExecutionEnv, type Result, type ShellExecOptions, type ShellExecResult } from "@earendil-works/pi-durable/env"
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node"
import { deadlineAfter, type HarnessServices, type OwnedProcess } from "../../contract/node"

const SHELL = existsSync("/bin/bash") ? "/bin/bash" : "bash"
const EXIT_STDIO_GRACE_MS = 100
const RETIRE_MS = 5_000

export type PiShellHost = { sessionId: string; services: HarnessServices; env: Readonly<Record<string, string>> }

type Exec = { owned: OwnedProcess; options: ShellExecOptions | undefined; context: Context }

const execFailure = (code: ExecutionError["code"], message: string): Result<ShellExecResult, ExecutionError> =>
  ({ ok: false, error: new ExecutionError(code, message) })

function drained(stream: Readable): Promise<void> {
  return new Promise((resolve) => { stream.once("end", resolve); stream.once("close", resolve) })
}

function forward(exec: Exec): void {
  for (const stream of [exec.owned.stdout, exec.owned.stderr]) {
    const decoder = new TextDecoder()
    stream.on("data", (chunk: Uint8Array) => {
      const text = decoder.decode(chunk, { stream: true })
      if (text) exec.options?.onOutput?.(text, exec.context)
    })
  }
}

async function settleExec(host: PiShellHost, exec: Exec): Promise<Result<ShellExecResult, ExecutionError>> {
  const { clock } = host.services
  let stopped: "aborted" | "timeout" | undefined
  const stop = (reason: "aborted" | "timeout") => { stopped ??= reason; void exec.owned.retire(deadlineAfter(clock, RETIRE_MS)) }
  const onAbort = () => stop("aborted")
  exec.context.abortSignal?.addEventListener("abort", onAbort, { once: true })
  const seconds = exec.options?.timeout
  const timer = seconds === undefined ? undefined : clock.setTimeout(() => stop("timeout"), seconds * 1000)
  try {
    const exit = await exec.owned.exited
    let grace: unknown
    await Promise.race([Promise.all([drained(exec.owned.stdout), drained(exec.owned.stderr)]),
      new Promise<void>((resolve) => { grace = clock.setTimeout(() => resolve(), EXIT_STDIO_GRACE_MS) })])
    clock.clearTimeout(grace)
    if (stopped) return execFailure(stopped, stopped === "timeout" ? `Command timed out after ${seconds} seconds` : "Command aborted")
    return { ok: true, value: { exitCode: exit.code ?? 1 } }
  } finally {
    clock.clearTimeout(timer)
    exec.context.abortSignal?.removeEventListener("abort", onAbort)
    await exec.owned.retire(deadlineAfter(clock, RETIRE_MS))
  }
}

async function ownedExec(host: PiShellHost, cwd: string, command: string, options: ShellExecOptions | undefined,
  context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
  if (context.abortSignal?.aborted) return execFailure("aborted", "aborted")
  if (options?.timeout !== undefined && !(Number.isFinite(options.timeout) && options.timeout > 0)) {
    return execFailure("timeout", "Invalid timeout: must be a finite number of seconds")
  }
  const env = options?.inheritEnv === false ? { ...options.env } : { ...host.env, ...options?.env }
  let owned: OwnedProcess
  try {
    owned = await host.services.spawn({ file: SHELL, args: ["-c", command], cwd: options?.cwd ? path.resolve(cwd, options.cwd) : cwd, env },
      { role: "harness", label: "Pi bash", sessionId: host.sessionId, signal: context.abortSignal ?? new AbortController().signal })
  } catch (error) {
    return execFailure("spawn_error", errorMessage(error))
  }
  owned.stdin.end()
  const exec = { owned, options, context }
  forward(exec)
  return settleExec(host, exec)
}

export function ownedExecutionEnv(host: PiShellHost, cwd: string): ExecutionEnv {
  const env = new NodeExecutionEnv({ cwd, shellEnv: host.env })
  return Object.assign(env, { exec: (command: string, options: ShellExecOptions | undefined, context: Context) =>
    ownedExec(host, env.cwd, command, options, context) })
}
