import { spawn, type ChildProcess } from "node:child_process"
import { realpath } from "node:fs/promises"
import { runtimeEnvText } from "./env"
import { buildSafeEnv } from "./pty/env"
import { limitConcurrency } from "@claxedo/helpers"
import { asRecord } from "@claxedo/helpers/guards"

export const GIT_TIMEOUT_MS = 10_000
/** A clone or first fetch takes as long as the repository is large; this bounds a stalled one, not a big one. */
export const GIT_CLONE_TIMEOUT_MS = 30 * 60_000
export const GIT_MAX_BUFFER = 50 * 1024 * 1024
export const GIT_CONCURRENCY = (() => {
  const raw = Number(runtimeEnvText(process.env, "WORKSPACE_RUNTIME_GIT_CONCURRENCY"))
  if (!Number.isFinite(raw) || raw <= 0) return 4
  return Math.max(1, Math.floor(raw))
})()

export type GitOptions = {
  timeoutMs: number
  maxBuffer: number
  env?: Readonly<Record<string, string>>
  signal?: AbortSignal
}

/**
 * An `Authorization` header git sends to one HTTPS host.
 *
 * A clone of a private repository has to authenticate, and the credential may
 * not ride on argv where `ps` reads it, so git takes it from `GIT_CONFIG_*`.
 * Those variables name an arbitrary config key, and `core.fsmonitor` or a clean
 * filter set through them is command execution inside the checkout — which is
 * why `CALLER_SET_ENV` refuses them and `buildSafeEnv` denies them. A caller
 * hands over the host and the header value instead, and this module writes the
 * one config entry those two can express.
 */
export type GitHttpCredential = {
  host: string
  authorization: string
}

/** Per-invocation overrides of the bounds, the environment and the credential a runner applies. */
export type GitRunOptions = {
  env?: Readonly<Record<string, string>>
  credential?: GitHttpCredential
  timeoutMs?: number
  maxBuffer?: number
  /** Ends git and what it started; git removes the lock files it holds on its way out. */
  signal?: AbortSignal
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

export class GitEnvironmentError extends Error {
  constructor(name: string) {
    super(`git environment variable ${name} may not be set by a caller`)
    this.name = "GitEnvironmentError"
  }
}

export class GitCredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GitCredentialError"
  }
}

/**
 * The only names a caller may add to a git child's environment.
 *
 * `GIT_INDEX_FILE` points git at a scratch index — the document commit builds
 * its tree in one rather than the repository's — which is git's own operational
 * state, not something the child reads as a credential. Every other name is
 * refused rather than merged: the filtered environment below is the whole
 * protection, and an open override is a way to put back exactly what it removed.
 */
const CALLER_SET_ENV = new Set(["GIT_INDEX_FILE"])

function requireCallerEnv(env: Readonly<Record<string, string>> | undefined) {
  if (!env) return undefined
  for (const name of Object.keys(env)) {
    if (!CALLER_SET_ENV.has(name)) throw new GitEnvironmentError(name)
  }
  return env
}

const CREDENTIAL_HOST = /^[A-Za-z0-9.-]+(?::\d+)?$/

function credentialEnv(credential: GitHttpCredential) {
  if (!CREDENTIAL_HOST.test(credential.host)) {
    throw new GitCredentialError(`git credential host ${credential.host} is not a host name`)
  }
  // git sends this value as a request header, so a line break in it is a second
  // header the repository host never agreed to receive.
  if (/[\r\n]/.test(credential.authorization)) {
    throw new GitCredentialError("git credential header may not contain a line break")
  }
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.https://${credential.host}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: ${credential.authorization}`,
  }
}

/**
 * Nobody is at the runtime's terminal to answer a credential prompt: a push to
 * a remote that wants a username would otherwise hang until the network
 * timeout. With prompts disabled git fails at once with a readable stderr.
 *
 * A checkout decides what git executes: `.git/hooks/*` on `commit`, `push` and
 * `worktree add`, and `core.fsmonitor` or a clean/smudge filter on operations
 * as ordinary as `status` and `add`. All of it runs as a child of this process,
 * which in embedded mode holds the control plane's own env — relay keys,
 * management tokens, the credential-store bearer. `buildSafeEnv` applies the
 * same deny-by-default `CLAXEDO_`/`WORKSPACE_RUNTIME_*` boundary managed
 * processes and PTYs already get.
 */
const GIT_ENV = { ...buildSafeEnv(process.env, { customPrefix: "CLAXEDO" }), GIT_TERMINAL_PROMPT: "0" }

/**
 * Git runs its transport (`git-remote-https`), hooks and aliases as children
 * that hold the network connection and inherit its output pipes, and Linux git
 * leaves them running when it is terminated. Started in its own process group
 * (which `execFile` cannot do), git is ended with all of them, and a run settles
 * once every process holding its output has exited. Windows has no process
 * groups: there git alone is ended and its output stops being read.
 */
const GIT_OWN_GROUP = process.platform !== "win32"

/** Only a git this runner has not reaped: until then its pid cannot name another group. */
function endGit(child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return false
  if (!GIT_OWN_GROUP) {
    child.stdout?.destroy()
    child.stderr?.destroy()
    return child.kill()
  }
  try {
    process.kill(-child.pid, "SIGTERM")
    return true
  } catch {
    return false
  }
}

function defaultGit(args: string[], cwd: string, options: GitOptions) {
  const env = options.env ? { ...GIT_ENV, ...options.env } : GIT_ENV
  return new Promise<{ stdout: string; stderr?: string }>((resolve, reject) => {
    const child = spawn("git", args, { cwd, env, detached: GIT_OWN_GROUP })
    const output = { stdout: "", stderr: "" }
    let failure: Error | undefined
    let ended = false
    const end = () => { ended = endGit(child) || ended }
    const collect = (stream: "stdout" | "stderr") => (chunk: string) => {
      if (failure) return
      output[stream] += chunk
      if (output[stream].length <= options.maxBuffer) return
      failure = new RangeError(`git ${stream} maxBuffer length exceeded`)
      end()
    }
    child.stdout.setEncoding("utf8").on("data", collect("stdout"))
    child.stderr.setEncoding("utf8").on("data", collect("stderr"))
    const timer = setTimeout(end, options.timeoutMs)
    const settle = (error: Error | undefined) => {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", end)
      if (error) reject(Object.assign(error, { killed: ended, ...output }))
      else resolve(output)
    }
    child.once("error", (error) => settle(error))
    child.once("close", (code, signal) => {
      if (failure || code !== 0) settle(failure ?? Object.assign(new Error(`Command failed: git ${args.join(" ")}\n${output.stderr}`), { code, signal }))
      else settle(undefined)
    })
    if (options.signal?.aborted) end()
    else options.signal?.addEventListener("abort", end, { once: true })
  })
}

export function createBoundedGit(options: BoundedGitOptions = {}) {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS
  const maxBuffer = options.maxBuffer ?? GIT_MAX_BUFFER
  const exec = options.exec ?? defaultGit
  const limit = limitConcurrency(Math.max(1, Math.floor(options.concurrency ?? GIT_CONCURRENCY)))

  return (args: string[], cwd: string, run?: GitRunOptions) => limit(async () => {
    const caller = requireCallerEnv(run?.env)
    const credential = run?.credential ? credentialEnv(run.credential) : undefined
    const env = caller || credential ? { ...caller, ...credential } : undefined
    const deadline = run?.timeoutMs ?? timeoutMs
    const execution = exec(args, cwd, {
      timeoutMs: deadline,
      maxBuffer: run?.maxBuffer ?? maxBuffer,
      ...(env ? { env } : {}),
      ...(run?.signal ? { signal: run.signal } : {}),
    })
    const timeout = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new GitTimeoutError(args)), deadline)
      execution.finally(() => clearTimeout(timer)).catch(() => {})
    })
    const result = await Promise.race([execution, timeout]).catch((err) => {
      if (err instanceof GitTimeoutError || run?.signal?.aborted) throw err
      const failure = asRecord(err)
      if (failure?.killed === true || failure?.signal === "SIGTERM") {
        throw new GitTimeoutError(args)
      }
      throw err
    })
    return result.stdout
  })
}

/**
 * Git's global switch for reading a pathspec as a filename, first in the
 * argument list.
 *
 * Every route here takes paths, resolves them against the workspace, and
 * authorizes what they resolved to. Without this git reads the same strings
 * as pathspecs instead: `container/*` matches files the resolved path never
 * named, `:(exclude)` subtracts from the set that was checked, and the path
 * git acts on stops being the path that was allowed. It also makes a file
 * genuinely called `a*.txt` reachable, which the glob reading never did.
 */
export const LITERAL_PATHSPECS = "--literal-pathspecs"

export const runGit = createBoundedGit()

/**
 * The repository `cwd` belongs to, as the filesystem names it.
 *
 * Most porcelain reports paths from here rather than from the directory it ran
 * in — `status` and `diff` name `sub/file.txt` when run inside `sub` — so a
 * caller comparing reported paths against directories on disk has to join them
 * onto this, not onto its own root.
 */
export async function gitTopLevel(
  cwd: string,
  /** The runner whose output is being placed, so a bounded or injected Git answers about its own repository. */
  run: (args: string[], cwd: string) => Promise<string> = runGit,
) {
  return await realpath((await run(["rev-parse", "--show-toplevel"], cwd)).trim())
}

const gitWriteLocks = new Map<string, Promise<void>>()

/**
 * Serializes the Git writes this process makes against one key.
 *
 * An index is shared mutable state: a route that reads what is staged,
 * decides on it, and then commits is deciding about an index another request
 * can change in between. Holding the key across read-decide-write makes the
 * two requests take turns. It binds nothing outside this process — the
 * session's own agent runs its own git — so a caller that must not commit
 * what it did not authorize commits the snapshot it decided about rather
 * than the index.
 */
export async function withGitWriteLock<T>(key: string, fn: () => Promise<T>) {
  const previous = gitWriteLocks.get(key) ?? Promise.resolve()
  let release = () => {}
  const current = previous.then(() => new Promise<void>((resolve) => {
    release = resolve
  }))
  gitWriteLocks.set(key, current)
  await previous
  try {
    return await fn()
  } finally {
    release()
    if (gitWriteLocks.get(key) === current) gitWriteLocks.delete(key)
  }
}

export async function optionalGit(args: string[], cwd: string) {
  try {
    return await runGit(args, cwd)
  } catch (err) {
    if (err instanceof GitTimeoutError) throw err
    return ""
  }
}
