import path from "path"
import { inside } from "@claxedo/helpers/path"
import fs from "node:fs/promises"
import { AsyncLocalStorage } from "async_hooks"
import { runtimeEnvText } from "./env"
import { realDirectoryPath, realPathAllowingMissing } from "./real-directory"

let id: string | undefined

export type WorkspaceTarget = {
  workspaceId: string
  directory: string
}

const targetStorage = new AsyncLocalStorage<WorkspaceTarget>()
const registered = new Map<string, Map<string, string>>()

export class WorkspaceTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkspaceTargetError"
  }
}

function clean(dir: string): string {
  return path.resolve(dir.trim())
}

export function workspaceDir(env: NodeJS.ProcessEnv = process.env): string {
  const target = targetStorage.getStore()
  if (target) return target.directory
  const raw = runtimeEnvText(env, "WORKSPACE_RUNTIME_DIRECTORY") ?? process.cwd()
  if (raw.includes(",")) {
    throw new Error("WORKSPACE_RUNTIME_DIRECTORY must contain exactly one directory")
  }
  return clean(raw)
}

/**
 * The workspace identity this runtime was told to serve, or `undefined` when
 * nobody told it one.
 *
 * `workspaceId` below cannot answer that question: with no target and no
 * configured id it mints a UUID so callers that merely need a stable process
 * label get one. That minted value names no workspace, so anything that
 * persists an identity — a port-lease directory, a claim label — has to be
 * able to tell it apart from an identity the placer assigned, and fall back to
 * something it can derive itself rather than write a workspace name it made up.
 */
export function authoritativeWorkspaceId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return targetStorage.getStore()?.workspaceId ?? runtimeEnvText(env, "WORKSPACE_RUNTIME_WORKSPACE_ID")
}

export function workspaceId(env: NodeJS.ProcessEnv = process.env): string {
  const authoritative = authoritativeWorkspaceId(env)
  if (authoritative) return authoritative
  if (env !== process.env) return crypto.randomUUID()
  id ??= crypto.randomUUID()
  return id
}

export function hasWorkspaceTarget(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!targetStorage.getStore() || !!runtimeEnvText(env, "WORKSPACE_RUNTIME_DIRECTORY")
}

export function assertTarget(requested: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const dir = workspaceDir(env)
  if (!requested) return dir
  if (requested.trim() === `workspace:${workspaceId(env)}`) return dir
  if (clean(requested) === dir) return dir
  if ([...(registered.get(workspaceId(env))?.values() ?? [])].includes(clean(requested))) return clean(requested)
  throw new WorkspaceTargetError(`workspace-runtime is pinned to ${dir}`)
}

export function registerWorkspaceDirectory(input: {
  workspaceId: string
  sessionId: string
  directory: string
}) {
  const directories = registered.get(input.workspaceId) ?? new Map<string, string>()
  directories.set(input.sessionId, clean(input.directory))
  registered.set(input.workspaceId, directories)
}

export function unregisterWorkspaceDirectory(input: { workspaceId: string; sessionId: string }) {
  const directories = registered.get(input.workspaceId)
  directories?.delete(input.sessionId)
  if (directories?.size === 0) registered.delete(input.workspaceId)
}

export function registeredWorkspaceDirectory(sessionId: string, env: NodeJS.ProcessEnv = process.env) {
  return registered.get(workspaceId(env))?.get(sessionId)
}

/** The per-session worktrees a workspace's runtime serves besides its own directory. */
export function registeredWorkspaceDirectories(workspaceId: string): string[] {
  return [...(registered.get(workspaceId)?.values() ?? [])]
}

export type RegisteredWorkspaceDirectory = { sessionId: string; directory: string }

function registeredEntries(env: NodeJS.ProcessEnv): RegisteredWorkspaceDirectory[] {
  return [...(registered.get(workspaceId(env)) ?? [])].map(([sessionId, directory]) => ({
    sessionId,
    directory: realDirectoryPath(directory),
  }))
}

/**
 * Every session whose registered worktree contains `candidate`, itself
 * included.
 *
 * Compared as the filesystem names both sides, so a symlink into a worktree,
 * a relative spelling, and `/tmp` against macOS's `/private/tmp` all answer
 * with the same owners. All of them, not the innermost: a worktree registered
 * under another worktree is private to both sessions, and a caller who holds
 * neither grant must not reach it through the one it is nested in.
 *
 * A path is only compared, never required to exist or to be contained — that
 * is the caller's own check, and this answers for the path it was handed.
 */
export function registeredWorkspaceDirectoryOwners(
  candidate: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const real = realPathAllowingMissing(candidate)
  return registeredEntries(env)
    .filter((entry) => real === entry.directory || real.startsWith(entry.directory + path.sep))
    .map((entry) => entry.sessionId)
}

/**
 * The registered worktrees that live under `root`, as the filesystem names
 * them.
 *
 * The other direction from {@link registeredWorkspaceDirectoryOwners}: what an
 * operation descends INTO, rather than what a path sits inside. A recursive
 * one — a directory pathspec handed to `git add`, a listing, a status walk —
 * reaches all of these, so they are as much its targets as the root it names.
 */
export function registeredWorkspaceDirectoriesUnder(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): RegisteredWorkspaceDirectory[] {
  const real = realPathAllowingMissing(root)
  return registeredEntries(env).filter((entry) => entry.directory.startsWith(real + path.sep))
}

/** Whether this workspace has any per-session worktree at all; the cheap guard before a filter does real work. */
export function hasRegisteredWorkspaceDirectories(env: NodeJS.ProcessEnv = process.env): boolean {
  return (registered.get(workspaceId(env))?.size ?? 0) > 0
}

export function withWorkspaceTarget<T>(target: WorkspaceTarget, run: () => T): T {
  return targetStorage.run({
    workspaceId: target.workspaceId,
    directory: clean(target.directory),
  }, run)
}

async function existingPath(input: string) {
  let current = input
  while (true) {
    try {
      return await fs.realpath(current)
    } catch {
      const next = path.dirname(current)
      if (next === current) throw new WorkspaceTargetError("workspace path does not exist")
      current = next
    }
  }
}

/**
 * The filesystem path a request-supplied path names under `root`.
 *
 * Only the spelling: the trim, the root it is joined onto, the absolute form
 * left alone. Whether the result is allowed is {@link resolveWorkspacePath}'s
 * decision and this answers nothing about it — but both go through here, so an
 * authorizer asking who owns a path and the read that follows it can never
 * resolve one request two ways. A leading space decided that once.
 */
export function workspacePathCandidate(
  root: string,
  input: string,
  options: { exactInput?: boolean } = {},
): string {
  const text = options.exactInput ? input : input.trim()
  if (!text) return path.resolve(root)
  return path.isAbsolute(text) ? path.resolve(text) : path.resolve(root, text)
}

export async function resolveWorkspacePath(
  root: string,
  input: string | undefined,
  // allowAbsoluteWithinRoot: permit an absolute path IFF it resolves inside the
  // workspace root. The containment + realpath checks below still reject any
  // path that escapes the workspace, so this does NOT reopen the M0 RCE (reading
  // e.g. the global ~/.local/share/opencode DB stays blocked — it's outside the
  // root). It only lets in-workspace absolute paths through, which the document
  // hydration feature legitimately produces.
  // exactInput: keep the input spelled as given. Typed and configured paths
  // arrive with stray whitespace and are trimmed by default; a path git
  // reported does not, and " lead/file.txt" trimmed resolves to a different
  // entry than the one git named.
  options: { allowAbsoluteWithinRoot?: boolean; exactInput?: boolean } = {},
): Promise<string> {
  const base = path.resolve(root)
  const txt = options.exactInput ? input : input?.trim()
  if (!txt) return base
  if (txt.includes("\0")) throw new WorkspaceTargetError("workspace path cannot contain null bytes")
  const absolute = path.isAbsolute(txt)
  if (absolute && !options.allowAbsoluteWithinRoot) throw new WorkspaceTargetError("workspace path must be relative")

  const realRoot = await fs.realpath(base)
  const candidate = workspacePathCandidate(base, txt, { exactInput: true })
  // Lexical pre-check. An absolute input may already be realpath-resolved
  // (e.g. /private/var/... on macOS) while `base` is not (/var/...), so accept
  // containment under either the raw or the realpath'd root; the realpath check
  // below is the authoritative, symlink-safe boundary.
  if (!inside(base, candidate) && !inside(realRoot, candidate)) {
    throw new WorkspaceTargetError("workspace path escapes configured directory")
  }

  const realExisting = await existingPath(candidate)
  if (!inside(realRoot, realExisting)) throw new WorkspaceTargetError("workspace path escapes configured directory")

  return candidate
}

// The boundary class is every character a path token can sit directly behind:
// whitespace, quotes, `=`, separators, redirection and grouping operators, and
// a backtick — `>out`, `2>log`, `cat</etc/passwd` and `` x=`/bin/x` `` all name
// paths. The scan enforces the command policy on the spellings it finds; it
// does not parse shell syntax and is not filesystem confinement.
const commandPathPattern = /(^|[\s"'`=,;(<>{}!|&)])((?:\/|~\/|\.\.?\/|\$HOME\/|\$\{HOME\}\/)[^\s"'`,;|&()<>{}!]+)/g

function commandPathReferences(input: string) {
  return [...input.matchAll(commandPathPattern)].map((match) => ({
    value: match[2].replace(/[\]}]+$/, ""),
    offset: match.index + match[1].length,
  }))
}

function executableReference(input: string, offset: number) {
  const prefix = input.slice(0, offset).trim()
  return prefix === "" || prefix === "\"" || prefix === "'"
}

export async function resolveWorkspaceCommandPaths(
  root: string,
  input: { command?: string; args?: string[]; allowAbsoluteExecutable?: boolean },
) {
  for (const reference of commandPathReferences(input.command ?? "")) {
    if (input.allowAbsoluteExecutable && path.isAbsolute(reference.value) && executableReference(input.command!, reference.offset)) {
      continue
    }
    if (reference.value.startsWith("~/") || reference.value.startsWith("$HOME/") || reference.value.startsWith("${HOME}/")) {
      throw new WorkspaceTargetError("workspace command path must be relative")
    }
    // Absolute paths are permitted only when they resolve inside the workspace
    // (e.g. hydrated document paths); escapes are still rejected by containment.
    await resolveWorkspacePath(root, reference.value, { allowAbsoluteWithinRoot: true })
  }
  for (const arg of input.args ?? []) {
    for (const reference of commandPathReferences(arg)) {
      if (reference.value.startsWith("~/") || reference.value.startsWith("$HOME/") || reference.value.startsWith("${HOME}/")) {
        throw new WorkspaceTargetError("workspace command path must be relative")
      }
      await resolveWorkspacePath(root, reference.value, { allowAbsoluteWithinRoot: true })
    }
  }
}
