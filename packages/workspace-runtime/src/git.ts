import { execFile } from "node:child_process"
import { runtimeEnvText } from "./env"
import { buildSafeEnv } from "./pty/env"
import { rec } from "./json-value"

export const GIT_TIMEOUT_MS = 10_000
export const GIT_MAX_BUFFER = 50 * 1024 * 1024
export const GIT_CONCURRENCY = (() => {
  const raw = Number(runtimeEnvText(process.env, "WORKSPACE_RUNTIME_GIT_CONCURRENCY"))
  if (!Number.isFinite(raw) || raw <= 0) return 4
  return Math.max(1, Math.floor(raw))
})()

export type GitOptions = {
  timeoutMs: number
  maxBuffer: number
}

export type GitExec = (args: string[], cwd: string, options: GitOptions) => Promise<{ stdout: string; stderr?: string }>

type BoundedGitOptions = {
  exec?: GitExec
  timeoutMs?: number
  maxBuffer?: number
  concurrency?: number
}

export class GitTimeoutError extends Error {
  constructor(args: string[]) {
    super(`git ${args[0] ?? "command"} timed out`)
    this.name = "GitTimeoutError"
  }
}

/**
 * Nobody is at the runtime's terminal to answer a credential prompt: a push to
 * a remote that wants a username would otherwise hang until the network
 * timeout. With prompts disabled git fails at once with a readable stderr.
 *
 * Git runs hook-executing commands (`commit`, `push`, `worktree add`) inside
 * the workspace checkout, and a planted `.git/hooks/*` inherits whatever env
 * git was launched with — in embedded mode that is the control plane's own
 * env, including relay keys and management tokens. `buildSafeEnv` applies the
 * same deny-by-default `CLAXEDO_`/`WORKSPACE_RUNTIME_*` boundary managed
 * processes and PTYs already get.
 */
const GIT_ENV = { ...buildSafeEnv(process.env, { customPrefix: "CLAXEDO" }), GIT_TERMINAL_PROMPT: "0" }

function defaultGit(args: string[], cwd: string, options: GitOptions) {
  return new Promise<{ stdout: string; stderr?: string }>((resolve, reject) => {
    execFile("git", args, { cwd, env: GIT_ENV, maxBuffer: options.maxBuffer, timeout: options.timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const hit = err as Error & { killed?: boolean; signal?: NodeJS.Signals; stderr?: string }
        hit.stderr = stderr
        reject(hit)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

function limitConcurrency(limit: number) {
  let active = 0
  const queue: Array<() => void> = []
  return async function run<T>(fn: () => Promise<T>) {
    if (active >= limit) {
      await new Promise<void>((resolve) => queue.push(resolve))
    }
    active += 1
    try {
      return await fn()
    } finally {
      active -= 1
      queue.shift()?.()
    }
  }
}

export function createBoundedGit(options: BoundedGitOptions = {}) {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS
  const maxBuffer = options.maxBuffer ?? GIT_MAX_BUFFER
  const exec = options.exec ?? defaultGit
  const limit = limitConcurrency(Math.max(1, Math.floor(options.concurrency ?? GIT_CONCURRENCY)))

  return (args: string[], cwd: string) => limit(async () => {
    const execution = exec(args, cwd, { timeoutMs, maxBuffer })
    const timeout = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new GitTimeoutError(args)), timeoutMs)
      execution.finally(() => clearTimeout(timer)).catch(() => {})
    })
    const result = await Promise.race([execution, timeout]).catch((err) => {
      if (err instanceof GitTimeoutError) throw err
      const failure = rec(err)
      if (failure?.killed === true || failure?.signal === "SIGTERM") {
        throw new GitTimeoutError(args)
      }
      throw err
    })
    return result.stdout
  })
}

export const runGit = createBoundedGit()

export async function optionalGit(args: string[], cwd: string) {
  try {
    return await runGit(args, cwd)
  } catch (err) {
    if (err instanceof GitTimeoutError) throw err
    return ""
  }
}
