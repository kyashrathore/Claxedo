import fs from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"
import { realpathSync } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { dataDir } from "./paths"
import { Log } from "./log"
import type { SandboxProviderID } from "./cloud/types"

const execFileAsync = promisify(execFile)

const log = Log.create({ service: "workspace-store" })

export type Workspace = {
  id: string
  project_id?: string
  project_name?: string
  workspace_name?: string
  directory: string
  kind: "local" | "cloud"
  provider?: SandboxProviderID
  repo_url?: string
  repo_key?: string
  repo_root?: string
  repo_name?: string
  git_branch?: string
  git_remote?: string
  sandbox_id?: string
  remote_directory?: string
  sandbox_url?: string
  status?: string
  available?: boolean
  created_at: number
  updated_at: number
}

type State = {
  version: 3
  workspaces: Workspace[]
}

const byId = new Map<string, Workspace>()
const byDir = new Map<string, string>()

let ready: Promise<void> | undefined
let loaded: string | undefined

function trim(input?: string) {
  const txt = input?.trim()
  return txt ? txt : undefined
}

function file() {
  return path.join(dataDir(), "workspaces.json")
}

function norm(dir: string) {
  try {
    return path.resolve(realpathSync.native?.(dir) ?? realpathSync(dir))
  } catch {
    return path.resolve(dir)
  }
}

/** Reject paths that must never become workspace entries */
function isRejectedDir(dir: string) {
  // /workspace is the WORKSPACE_DIR inside cloud containers — never a host workspace
  if (dir === "/workspace") return true
  // __pages__ is a frontend sentinel directory — never a real workspace
  if (path.basename(dir) === "__pages__") return true
  return false
}

async function gitCmd(dir: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, ...args])
    return trim(stdout)
  } catch {
    return undefined
  }
}

async function git(dir: string) {
  const root = await gitCmd(dir, ["rev-parse", "--show-toplevel"])
  if (!root) return {}
  const key = await gitCmd(dir, ["rev-parse", "--git-common-dir"])
  const branch = await gitCmd(dir, ["rev-parse", "--abbrev-ref", "HEAD"])
  const remote = await gitCmd(dir, ["remote", "get-url", "origin"])
  const repo_root = norm(root)
  const repo_key = key ? norm(path.resolve(dir, key)) : repo_root
  const repo_name = remote
    ? trim(path.basename(remote.replace(/\/+$/, "")).replace(/\.git$/, ""))
    : trim(path.basename(repo_root))
  return {
    repo_key,
    repo_root,
    repo_name,
    git_branch: branch,
    git_remote: remote,
  }
}

async function exists(dir: string) {
  try {
    const stat = await fs.stat(dir)
    return stat.isDirectory()
  } catch {
    return false
  }
}

function main(rows: Workspace[]) {
  return rows.find((row) => row.id === row.project_id)
    ?? rows.find((row) => row.workspace_name === "main")
    ?? [...rows].sort((a, b) => a.created_at - b.created_at)[0]
}

function projectId(key: string) {
  const rows = [...byId.values()].filter((row) => row.repo_key === key)
  const root = rows.length ? main(rows) : undefined
  return root?.project_id
}

async function load(target: string) {
  try {
    const raw = JSON.parse(await fs.readFile(target, "utf-8"))
    const state = raw as Partial<State>
    for (const item of state.workspaces ?? []) {
      const ws: Workspace = {
        id: item.id,
        project_id: trim(item.project_id) || item.id,
        project_name: trim(item.project_name),
        workspace_name: trim(item.workspace_name),
        directory: norm(item.directory),
        kind: item.kind === "cloud" ? "cloud" : "local",
        provider: item.provider,
        repo_url: trim(item.repo_url),
        repo_key: item.repo_key ? norm(item.repo_key) : undefined,
        repo_root: item.repo_root ? norm(item.repo_root) : undefined,
        repo_name: trim(item.repo_name),
        git_branch: trim(item.git_branch),
        git_remote: trim(item.git_remote),
        sandbox_id: trim(item.sandbox_id),
        remote_directory: trim(item.remote_directory),
        sandbox_url: trim(item.sandbox_url),
        status: trim(item.status),
        created_at: item.created_at ?? Date.now(),
        updated_at: item.updated_at ?? Date.now(),
      }
      byId.set(ws.id, ws)
      byDir.set(ws.directory, ws.id)
    }
  } catch {}
}

async function save() {
  const target = loaded ?? file()
  await fs.mkdir(path.dirname(target), { recursive: true })
  const state: State = {
    version: 3,
    workspaces: [...byId.values()].sort((a, b) => a.created_at - b.created_at),
  }
  await fs.writeFile(target, JSON.stringify(state, null, 2) + "\n")
}

async function boot() {
  const target = file()
  const fresh = await fs.access(target).then(() => true, () => false)
  if (!ready || loaded !== target || !fresh) {
    loaded = target
    byId.clear()
    byDir.clear()
    ready = load(target).catch((err) => {
      log.warn("Failed to load workspaces", { error: err instanceof Error ? err.message : String(err) })
    })
  }
  await ready
}

function upsert(ws: Workspace) {
  byId.set(ws.id, ws)
  byDir.set(ws.directory, ws.id)
  return ws
}

export async function listWorkspaces() {
  await boot()
  return [...byId.values()].sort((a, b) => b.updated_at - a.updated_at)
}

export async function getWorkspace(id: string) {
  await boot()
  return byId.get(id)
}

export async function getProjectWorkspace(id: string) {
  await boot()
  const rows = [...byId.values()].filter((row) => row.project_id === trim(id))
  return rows.length ? main(rows) : undefined
}

export async function getWorkspaceByDirectory(dir: string) {
  await boot()
  const key = byDir.get(norm(dir))
  return key ? byId.get(key) : undefined
}

export async function ensureWorkspace(input: {
  workspaceId?: string
  project_id?: string
  project_name?: string
  workspace_name?: string
  directory: string
  kind?: "local" | "cloud"
  provider?: SandboxProviderID
  repo_url?: string
  sandbox_id?: string
  remote_directory?: string
  sandbox_url?: string
  status?: string
}) {
  await boot()
  const directory = norm(input.directory)
  if (isRejectedDir(directory)) return undefined
  const info = await git(directory)
  // For cloud workspaces with no local git, derive repo_name from repo_url
  if (!info.repo_name && input.repo_url) {
    info.repo_name = trim(path.basename(input.repo_url.replace(/\/+$/, "")).replace(/\.git$/, ""))
    info.git_remote = trim(input.repo_url)
  }
  const now = Date.now()
  const hit = byDir.get(directory)
  if (hit) {
    const ws = byId.get(hit)!
    const project_id = trim(input.project_id) || ws.project_id || (info.repo_key ? projectId(info.repo_key) : undefined) || ws.id
    const project_name = trim(input.project_name) || ws.project_name
    const workspace_name = trim(input.workspace_name) || ws.workspace_name
    const kind = input.kind ?? ws.kind
    const provider = input.provider ?? ws.provider
    const repo_url = trim(input.repo_url) || ws.repo_url
    const sandbox_id = trim(input.sandbox_id) || ws.sandbox_id
    const remote_directory = trim(input.remote_directory) || ws.remote_directory
    const sandbox_url = trim(input.sandbox_url) || ws.sandbox_url
    const status = trim(input.status) || ws.status
    const same =
      ws.project_id === project_id &&
      ws.project_name === project_name &&
      ws.workspace_name === workspace_name &&
      ws.kind === kind &&
      ws.provider === provider &&
      ws.repo_url === repo_url &&
      ws.repo_key === info.repo_key &&
      ws.repo_root === info.repo_root &&
      ws.repo_name === info.repo_name &&
      ws.git_branch === info.git_branch &&
      ws.git_remote === info.git_remote &&
      ws.sandbox_id === sandbox_id &&
      ws.remote_directory === remote_directory &&
      ws.sandbox_url === sandbox_url &&
      ws.status === status
    const next = same && ws.updated_at === now
      ? ws
      : {
          ...ws,
          project_id,
          project_name,
          workspace_name,
          kind,
          provider,
          repo_url,
          repo_key: info.repo_key ?? ws.repo_key,
          repo_root: info.repo_root ?? ws.repo_root,
          repo_name: info.repo_name ?? ws.repo_name,
          git_branch: info.git_branch ?? ws.git_branch,
          git_remote: info.git_remote ?? ws.git_remote,
          sandbox_id,
          remote_directory,
          sandbox_url,
          status,
          updated_at: now,
        }
    upsert(next)
    await save()
    return next
  }

  // New local workspaces require a git repo
  if (input.kind !== "cloud" && !info.repo_key) return undefined

  const id = trim(input.workspaceId) || randomUUID()
  const ws = upsert({
    id,
    project_id: trim(input.project_id) || (info.repo_key ? projectId(info.repo_key) : undefined) || id,
    project_name: trim(input.project_name),
    workspace_name: trim(input.workspace_name),
    directory,
    kind: input.kind ?? "local",
    provider: input.provider,
    repo_url: trim(input.repo_url),
    repo_key: info.repo_key,
    repo_root: info.repo_root,
    repo_name: info.repo_name,
    git_branch: info.git_branch,
    git_remote: info.git_remote,
    sandbox_id: trim(input.sandbox_id),
    remote_directory: trim(input.remote_directory),
    sandbox_url: trim(input.sandbox_url),
    status: trim(input.status),
    created_at: now,
    updated_at: now,
  })
  await save()
  log.info("Workspace stored", { workspaceId: id, directory })
  return ws
}

export async function bindWorkspace(id: string, dir: string) {
  await boot()
  const ws = byId.get(id)
  if (!ws) return ensureWorkspace({ workspaceId: id, directory: dir })
  const directory = norm(dir)
  if (ws.directory === directory) return ws
  const info = await git(directory)
  byDir.delete(ws.directory)
  const next = upsert({
    ...ws,
    directory,
    repo_key: info.repo_key ?? ws.repo_key,
    repo_root: info.repo_root ?? ws.repo_root,
    repo_name: info.repo_name ?? ws.repo_name,
    git_branch: info.git_branch ?? ws.git_branch,
    git_remote: info.git_remote ?? ws.git_remote,
    updated_at: Date.now(),
  })
  await save()
  log.info("Workspace rebound", { workspaceId: id, directory })
  return next
}

export async function deleteWorkspaceByDirectory(dir: string) {
  await boot()
  const key = byDir.get(norm(dir))
  if (!key) return false
  const ws = byId.get(key)
  if (!ws) return false
  byDir.delete(ws.directory)
  byId.delete(key)
  await save()
  log.info("Workspace deleted", { workspaceId: key, directory: ws.directory })
  return true
}

export async function resolveWorkspace(input: { workspaceId?: string; directory?: string; create?: boolean }) {
  await boot()
  const id = input.workspaceId?.trim()
  if (id && byId.has(id)) return byId.get(id)
  const dir = input.directory?.trim()
  if (!dir) return undefined
  if (isRejectedDir(norm(dir))) return undefined
  if (!input.create) return getWorkspaceByDirectory(dir)
  return ensureWorkspace({
    workspaceId: id,
    directory: dir,
  })
}

export async function listProjects() {
  await boot()
  const map = new Map<string, Workspace[]>()
  for (const row of byId.values()) {
    const key = row.project_id ?? row.id
    const list = map.get(key)
    if (list) {
      list.push(row)
      continue
    }
    map.set(key, [row])
  }

  const list = await Promise.all([...map.entries()]
    .filter(([, rows]) => !rows.every((row) => isRejectedDir(row.directory)))
    .map(async ([id, rows]) => {
      const all = [...rows].sort((a, b) => a.created_at - b.created_at)
      const root = main(all)!
      const repoRoot = root.repo_root ?? root.directory
      const others = all.filter((row) => {
        if (row.id === root.id) return false
        // Cloud workspaces are always real sandboxes
        if (row.kind === "cloud") return true
        // Git worktrees have a different repo_root — keep them
        if (row.repo_root && row.repo_root !== repoRoot) return true
        // Subdirectories of the repo root are not real workspaces
        if (row.directory.startsWith(repoRoot + "/")) return false
        return true
      })
      const sandboxes = others.map((row) => row.directory)
      const workspaces: Record<string, Workspace> = {}
      const status = new Map(await Promise.all(
        [root, ...others].map(async (row) => [row.directory, row.kind === "cloud" ? true : await exists(row.directory)] as const),
      ))
      for (const row of [root, ...others]) {
        workspaces[row.directory] = {
          ...row,
          available: status.get(row.directory) ?? true,
        }
      }

      return {
        id,
        worktree: root.directory,
        name: root.project_name || root.repo_name || path.basename(root.directory) || root.directory,
        kind: root.kind,
        provider: root.provider ?? null,
        git: {
          repo: root.repo_name ?? null,
          branch: root.git_branch ?? null,
          remote: root.git_remote ?? null,
        },
        sandboxes,
        workspaces,
        time: {
          created: Math.min(...all.map((row) => row.created_at)),
          updated: Math.max(...all.map((row) => row.updated_at)),
        },
      }
    }))

  return list.sort((a, b) => b.time.updated - a.time.updated)
}
