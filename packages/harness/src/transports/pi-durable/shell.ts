import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Context } from "@earendil-works/chord"
import { ExecutionError, type ExecutionEnv, type Result, type ShellExecOptions, type ShellExecResult } from "@earendil-works/pi-durable/env"
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node"
import { SessionRunner, type RunnerCommand, type RunnerServices, type RunOutcome } from "./runner"

export { RUNNER_RESTARTED_NOTICE, type RunnerCommand } from "./runner"

const EXIT_STDIO_GRACE_MS = 2_000

export type PiShellServices = RunnerServices

export type PiShellHost = { sessionId: string; services: PiShellServices; env: Readonly<Record<string, string>>; runner: SessionRunner; shell: string | undefined }

export const NO_SHELL_MESSAGE = "Shell commands need Git for Windows (git-scm.com) on this machine; install it and restart claxedo connect"

export function piShell(input: { platform: NodeJS.Platform; env: Readonly<Record<string, string | undefined>>; exists: (file: string) => boolean }): string | undefined {
  if (input.platform !== "win32") return input.exists("/bin/bash") ? "/bin/bash" : "bash"
  const variable = (name: string) => Object.entries(input.env).find(([key]) => key.toUpperCase() === name)?.[1]
  const pathDirs = (variable("PATH") ?? "").split(";").filter(Boolean)
  const candidates = [
    ...[variable("PROGRAMFILES"), variable("PROGRAMFILES(X86)")].flatMap((dir) => dir ? [path.win32.join(dir, "Git", "bin", "bash.exe")] : []),
    ...pathDirs.filter((dir) => input.exists(path.win32.join(dir, "git.exe"))).map((dir) => path.win32.join(dir, "..", "bin", "bash.exe")),
    ...pathDirs.map((dir) => path.win32.join(dir, "bash.exe")).filter((file) => !/^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/i.test(file)),
  ]
  return candidates.find((file) => input.exists(file))
}

export function resolvedPiShell(env: Readonly<Record<string, string | undefined>>): string | undefined {
  return piShell({ platform: process.platform, env, exists: existsSync })
}

const execFailure = (code: ExecutionError["code"], message: string): Result<ShellExecResult, ExecutionError> =>
  ({ ok: false, error: new ExecutionError(code, message) })

const SIGNAL_NUMBERS: Readonly<Record<string, number | undefined>> = os.constants.signals

function exitCode(exit: { code: number | null; signal: string | null }): number {
  if (exit.code !== null) return exit.code
  const signal = exit.signal ? SIGNAL_NUMBERS[exit.signal] : undefined
  return signal === undefined ? 1 : 128 + signal
}

async function ownedExec(host: PiShellHost, cwd: string, command: string, options: ShellExecOptions | undefined,
  context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
  if (context.abortSignal?.aborted) return execFailure("aborted", "aborted")
  if (options?.timeout !== undefined && !(Number.isFinite(options.timeout) && options.timeout > 0)) {
    return execFailure("timeout", "Invalid timeout: must be a finite number of seconds")
  }
  if (host.shell === undefined) return execFailure("spawn_error", NO_SHELL_MESSAGE)
  const { clock } = host.services
  const env = options?.inheritEnv === false ? { ...options.env } : { ...host.env, ...options?.env }
  let settled = false
  const emit = (text: string) => { if (text && !settled) options?.onOutput?.(text, context) }
  const started = await host.runner.start({ file: host.shell, args: ["-c", command], cwd: options?.cwd ? path.resolve(cwd, options.cwd) : cwd, env, onOutput: emit })
  if ("failed" in started) return execFailure("spawn_error", started.failed)
  let stopped: "aborted" | "timeout" | undefined
  const stop = (reason: "aborted" | "timeout") => { stopped ??= reason; host.runner.kill(started.id) }
  const onAbort = () => stop("aborted")
  context.abortSignal?.addEventListener("abort", onAbort, { once: true })
  const seconds = options?.timeout
  const timer = seconds === undefined ? undefined : clock.setTimeout(() => stop("timeout"), seconds * 1000)
  let outcome: RunOutcome
  try {
    outcome = await started.outcome
  } finally {
    clock.clearTimeout(timer)
    context.abortSignal?.removeEventListener("abort", onAbort)
  }
  if ("exit" in outcome) await new Promise<void>((resolve) => { clock.setTimeout(() => resolve(), EXIT_STDIO_GRACE_MS) })
  settled = true
  host.runner.release(started.id)
  if (stopped) return execFailure(stopped, stopped === "timeout" ? `Command timed out after ${seconds} seconds` : "Command aborted")
  if ("failed" in outcome) return execFailure("spawn_error", outcome.failed)
  if ("ended" in outcome) return execFailure("spawn_error", outcome.ended)
  return { ok: true, value: { exitCode: exitCode(outcome.exit) } }
}

export function sessionCommands(services: PiShellServices, command: RunnerCommand, env: Readonly<Record<string, string>>) {
  const runners = new Map<string, SessionRunner>()
  const of = (sessionId: string, cwd: string): SessionRunner => {
    const existing = runners.get(sessionId)
    if (existing) return existing
    const runner = new SessionRunner(services, command, sessionId, cwd, env)
    runners.set(sessionId, runner)
    return runner
  }
  const retire = async (sessionId: string): Promise<void> => {
    const runner = runners.get(sessionId)
    runners.delete(sessionId)
    await runner?.end()
  }
  return { of, retire, sessions: () => [...runners.keys()], retireAll: async () => { await Promise.all([...runners.keys()].map(retire)) } }
}

export function ownedExecutionEnv(host: PiShellHost, cwd: string): ExecutionEnv {
  const env = new NodeExecutionEnv({ cwd, shellEnv: host.env })
  return Object.assign(env, { exec: (command: string, options: ShellExecOptions | undefined, context: Context) =>
    ownedExec(host, env.cwd, command, options, context) })
}
