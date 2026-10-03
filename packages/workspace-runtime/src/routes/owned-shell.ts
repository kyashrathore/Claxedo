import { existsSync } from "node:fs"
import path from "node:path"
import type { Readable } from "node:stream"
import { errorMessage } from "@claxedo/helpers"
import type { HarnessServices, OwnedProcess } from "@claxedo/harness/contract"
import type { Context } from "@earendil-works/chord"
import { ExecutionError, type Result, type ShellExecOptions, type ShellExecResult } from "@earendil-works/pi-durable/env"

const SHELL = existsSync("/bin/bash") ? "/bin/bash" : "bash"
const EXIT_STDIO_GRACE_MS = 100
const RETIRE_MS = 5_000

export type OwnedShellHost = {
  spawn: HarnessServices["spawn"]
  sessionId: string
  env: Readonly<Record<string, string | undefined>>
}

export function spawnEnv(...layers: ReadonlyArray<Readonly<Record<string, string | undefined>> | undefined>): Record<string, string> {
  return Object.fromEntries(layers.flatMap((layer) => Object.entries(layer ?? {}))
    .filter((entry): entry is [string, string] => entry[1] !== undefined))
}

const failure = (code: ExecutionError["code"], message: string): Result<ShellExecResult, ExecutionError> =>
  ({ ok: false, error: new ExecutionError(code, message) })

const retireSoon = (owned: OwnedProcess) => owned.retire({ at: Date.now() + RETIRE_MS, signal: new AbortController().signal })

function drained(stream: Readable): Promise<void> {
  return new Promise((resolve) => { stream.once("end", resolve); stream.once("close", resolve) })
}

function forwardOutput(owned: OwnedProcess, options: ShellExecOptions | undefined, context: Context) {
  for (const stream of [owned.stdout, owned.stderr]) {
    const decoder = new TextDecoder()
    stream.on("data", (chunk: Uint8Array) => {
      const text = decoder.decode(chunk, { stream: true })
      if (text) options?.onOutput?.(text, context)
    })
  }
}

async function settle(owned: OwnedProcess, options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
  let stopped: "aborted" | "timeout" | undefined
  const stop = (reason: "aborted" | "timeout") => { stopped ??= reason; void retireSoon(owned) }
  const onAbort = () => stop("aborted")
  context.abortSignal?.addEventListener("abort", onAbort, { once: true })
  const seconds = options?.timeout
  const timer = seconds === undefined ? undefined : setTimeout(() => stop("timeout"), seconds * 1000)
  try {
    const exit = await owned.exited
    let grace: ReturnType<typeof setTimeout> | undefined
    await Promise.race([Promise.all([drained(owned.stdout), drained(owned.stderr)]),
      new Promise<void>((resolve) => { grace = setTimeout(resolve, EXIT_STDIO_GRACE_MS) })])
    clearTimeout(grace)
    if (stopped) return failure(stopped, stopped === "timeout" ? `Command timed out after ${seconds} seconds` : "Command aborted")
    return { ok: true, value: { exitCode: exit.code ?? 1 } }
  } finally {
    clearTimeout(timer)
    context.abortSignal?.removeEventListener("abort", onAbort)
    await retireSoon(owned)
  }
}

export async function ownedShellExec(host: OwnedShellHost, cwd: string, command: string, options: ShellExecOptions | undefined,
  context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
  if (context.abortSignal?.aborted) return failure("aborted", "Command aborted")
  if (options?.timeout !== undefined && !(Number.isFinite(options.timeout) && options.timeout > 0)) {
    return failure("timeout", "Invalid timeout: must be a finite number of seconds")
  }
  const env = options?.inheritEnv === false ? spawnEnv(options.env) : spawnEnv(host.env, options?.env)
  let owned: OwnedProcess
  try {
    owned = await host.spawn({ file: SHELL, args: ["-c", command], cwd: options?.cwd ? path.resolve(cwd, options.cwd) : cwd, env },
      { role: "harness", label: "Pi execution-env shell", sessionId: host.sessionId, signal: context.abortSignal ?? new AbortController().signal })
  } catch (error) {
    return failure(context.abortSignal?.aborted ? "aborted" : "spawn_error", errorMessage(error))
  }
  owned.stdin.end()
  forwardOutput(owned, options, context)
  return settle(owned, options, context)
}
