import path from "path"
import { inside } from "@claxedo/helpers/path"
import fs from "node:fs/promises"
import { AsyncLocalStorage } from "async_hooks"
import { runtimeEnvText } from "./env"
import { realDirectoryPath, realPathAllowingMissing } from "@claxedo/helpers/real-path"

import { currentSessionCore } from "./session-context"
import { WorkspaceTargetError } from "@claxedo/session-core"

let id: string | undefined

export type WorkspaceTarget = {
  workspaceId: string
  directory: string
}

const targetStorage = new AsyncLocalStorage<WorkspaceTarget>()

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

export type RegisteredWorkspaceDirectory = { sessionId: string; directory: string }

function registeredEntries(): RegisteredWorkspaceDirectory[] {
  return currentSessionCore().placement.entries().map((entry) => ({ ...entry, directory: realDirectoryPath(entry.directory) }))
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
): string[] {
  const real = realPathAllowingMissing(candidate)
  return registeredEntries()
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
): RegisteredWorkspaceDirectory[] {
  const real = realPathAllowingMissing(root)
  return registeredEntries().filter((entry) => entry.directory.startsWith(real + path.sep))
}

/** Whether this workspace has any per-session worktree at all; the cheap guard before a filter does real work. */
export function hasRegisteredWorkspaceDirectories(): boolean {
  return currentSessionCore().placement.entries().length > 0
}

export function withWorkspaceTarget<T>(target: WorkspaceTarget, run: () => T): T {
  return targetStorage.run({
    workspaceId: target.workspaceId,
    directory: clean(target.directory),
  }, run)
}

type PathAccess = { path?: typeof path; realpath?: (file: string) => Promise<string> }

async function existingPath(input: string, paths: typeof path, realpath: (file: string) => Promise<string>) {
  let current = input
  while (true) {
    try {
      return await realpath(current)
    } catch {
      const next = paths.dirname(current)
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
  options: { exactInput?: boolean; path?: typeof path } = {},
): string {
  const paths = options.path ?? path
  const text = options.exactInput ? input : input.trim()
  if (!text) return paths.resolve(root)
  return paths.isAbsolute(text) ? paths.resolve(text) : paths.resolve(root, text)
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
  options: PathAccess & { allowAbsoluteWithinRoot?: boolean; exactInput?: boolean } = {},
): Promise<string> {
  const paths = options.path ?? path
  const realpath = options.realpath ?? fs.realpath
  const base = paths.resolve(root)
  const txt = options.exactInput ? input : input?.trim()
  if (!txt) return base
  if (txt.includes("\0")) throw new WorkspaceTargetError("workspace path cannot contain null bytes")
  const absolute = paths.isAbsolute(txt)
  if (absolute && !options.allowAbsoluteWithinRoot) throw new WorkspaceTargetError("workspace path must be relative")

  const realRoot = await realpath(base)
  const candidate = workspacePathCandidate(base, txt, { exactInput: true, path: paths })
  // Lexical pre-check. An absolute input may already be realpath-resolved
  // (e.g. /private/var/... on macOS) while `base` is not (/var/...), so accept
  // containment under either the raw or the realpath'd root; the realpath check
  // below is the authoritative, symlink-safe boundary.
  if (!inside(base, candidate, paths) && !inside(realRoot, candidate, paths)) {
    throw new WorkspaceTargetError("workspace path escapes configured directory")
  }

  const realExisting = await existingPath(candidate, paths, realpath)
  if (!inside(realRoot, realExisting, paths)) throw new WorkspaceTargetError("workspace path escapes configured directory")

  return candidate
}

// The boundary class is every character a path token can sit directly behind:
// whitespace, quotes, `=`, separators, redirection and grouping operators, and
// a backtick — `>out`, `2>log`, `cat</etc/passwd` and `` x=`/bin/x` `` all name
// paths. The scan enforces the command policy on the spellings it finds; it
// does not parse shell syntax and is not filesystem confinement.
const commandPathPattern = /(^|[\s"'`=,;(<>{}!|&)])((?:\/|~\/|\.\.?\/|\$HOME\/|\$\{HOME\}\/)[^\s"'`,;|&()<>{}!]+)/g
const windowsCommandPathPattern = /(^|[\s"'`=,;(<>{}!|&)])((?:[A-Za-z]:[\\/]|[\\/]|~[\\/]|\.\.?[\\/]|\$HOME[\\/]|\$\{HOME\}[\\/]|%USERPROFILE%[\\/]|\$env:USERPROFILE[\\/])[^\s"'`,;|&()<>{}!]+)/gi
const homeReference = /^(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)[\\/]/i

function commandPathReferences(input: string, paths: typeof path) {
  return [...input.matchAll(paths.sep === "\\" ? windowsCommandPathPattern : commandPathPattern)].map((match) => ({
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
  options: PathAccess = {},
) {
  const paths = options.path ?? path
  const entries = [{ text: input.command ?? "", executable: input.allowAbsoluteExecutable },
    ...(input.args ?? []).map((text) => ({ text, executable: false }))]
  for (const entry of entries) {
    for (const reference of commandPathReferences(entry.text, paths)) {
      if (entry.executable && paths.isAbsolute(reference.value) && executableReference(entry.text, reference.offset)) continue
      if (homeReference.test(reference.value)) throw new WorkspaceTargetError("workspace command path must be relative")
      await resolveWorkspacePath(root, reference.value, { ...options, allowAbsoluteWithinRoot: true })
    }
  }
}
