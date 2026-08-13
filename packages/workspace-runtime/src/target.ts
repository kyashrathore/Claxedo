import path from "path"
import fs from "node:fs/promises"
import { AsyncLocalStorage } from "async_hooks"
import { runtimeEnvText } from "./env"

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

export function workspaceId(env: NodeJS.ProcessEnv = process.env): string {
  const target = targetStorage.getStore()
  if (target) return target.workspaceId
  const configured = runtimeEnvText(env, "WORKSPACE_RUNTIME_WORKSPACE_ID")
  if (configured) return configured
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

export function withWorkspaceTarget<T>(target: WorkspaceTarget, run: () => T): T {
  return targetStorage.run({
    workspaceId: target.workspaceId,
    directory: clean(target.directory),
  }, run)
}

function inside(root: string, candidate: string) {
  return candidate === root || candidate.startsWith(root + path.sep)
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

export async function resolveWorkspacePath(
  root: string,
  input: string | undefined,
  // allowAbsoluteWithinRoot: permit an absolute path IFF it resolves inside the
  // workspace root. The containment + realpath checks below still reject any
  // path that escapes the workspace, so this does NOT reopen the M0 RCE (reading
  // e.g. the global ~/.local/share/opencode DB stays blocked — it's outside the
  // root). It only lets in-workspace absolute paths through, which the document
  // hydration feature legitimately produces.
  options: { allowAbsoluteWithinRoot?: boolean } = {},
): Promise<string> {
  const base = path.resolve(root)
  const txt = input?.trim()
  if (!txt) return base
  if (txt.includes("\0")) throw new WorkspaceTargetError("workspace path cannot contain null bytes")
  const absolute = path.isAbsolute(txt)
  if (absolute && !options.allowAbsoluteWithinRoot) throw new WorkspaceTargetError("workspace path must be relative")

  const realRoot = await fs.realpath(base)
  const candidate = absolute ? path.resolve(txt) : path.resolve(base, txt)
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

const commandPathPattern = /(^|[\s"'=,;(])((?:\/|~\/|\.\.?\/|\$HOME\/|\$\{HOME\}\/)[^\s"'`,;|&)]+)/g

function commandPathReferences(input: string) {
  return [...input.matchAll(commandPathPattern)].map((match) => ({
    value: match[2]!.replace(/[\]}]+$/, ""),
    offset: match.index + match[1]!.length,
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
