import { execFile } from "node:child_process"
import { runtimeEnvText } from "./env"

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

function defaultGit(args: string[], cwd: string, options: GitOptions) {
  return new Promise<{ stdout: string; stderr?: string }>((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: options.maxBuffer, timeout: options.timeoutMs }, (err, stdout, stderr) => {
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
      if ((err as { killed?: boolean; signal?: NodeJS.Signals })?.killed || (err as { signal?: NodeJS.Signals })?.signal === "SIGTERM") {
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

export async function boundedGitExecFile(file: string, args: string[], options?: { cwd?: string }) {
  if (file !== "git") throw new Error(`Unsupported bounded execFile binary: ${file}`)
  return {
    stdout: await runGit(args, options?.cwd ?? process.cwd()),
    stderr: "",
  }
}
