import fs from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"
import { realpathSync } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { dockerSandboxDriverEnabled, type SandboxDriverID } from "@claxedo/sandbox-contract"

const execFileAsync = promisify(execFile)

const log = Log.create({ service: "workspace-store" })

/**
 * Reads the provisioning lease for a cloud workspace.
 *
 * Only cloud workspaces have one, and a desktop-local build has no cloud
 * workspaces at all — yet importing the supervisor lease store directly put the
 * whole cloud sandbox graph inside the closure of every module that reads local
 * workspace inventory. A composition that provisions sandboxes supplies this;
 * one that does not leaves it unset, and an unfinished cloud workspace stays
 * hidden exactly as it does today when the lease lookup fails.
 */
export type WorkspaceSandboxLeaseReader = (workspaceId: string) =>
  | { status?: string; last_error?: string | null }
  | undefined

let sandboxLeaseReader: WorkspaceSandboxLeaseReader | undefined

export function configureWorkspaceStore(options: { sandboxLease?: WorkspaceSandboxLeaseReader } = {}) {
  sandboxLeaseReader = options.sandboxLease
}

/**
 * Whether a composition installed a lease reader.
 *
 * Exposed so the install is checkable. Without a reader, a cloud workspace in
 * `acquiring_sandbox` never becomes visible — nothing else moves that status —
 * so a dropped install hides every provisioned cloud workspace and its whole
 * project, silently.
 */
export function workspaceSandboxLeaseInstalled() {
  return sandboxLeaseReader !== undefined
}

export type Workspace = {
  id: string
  org_id?: string
  project_id?: string
  project_name?: string
  workspace_name?: string
  directory: string
  kind: "local" | "cloud"
  driver?: SandboxDriverID
  repo_url?: string
  repo_key?: string
  repo_root?: string
  repo_name?: string
  git_branch?: string
  git_remote?: string
  sandbox_id?: string
  remote_directory?: string
  status?: string
  available?: boolean
  created_at: number
  updated_at: number
}

type State = {
  version: 4
  workspaces: Workspace[]
}

type StoredWorkspace = Omit<Workspace, "driver"> & {
  driver?: SandboxDriverID
}

const byId = new Map<string, Workspace>()
const byDir = new Map<string, string>()
const listeners = new Set<() => void | Promise<void>>()
const localFirstTouch = new Map<string, Promise<Workspace | undefined>>()

let ready: Promise<void> | undefined
let loaded: string | undefined

export function subscribeLocalWorkspaceChanges(listener: () => void | Promise<void>) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notifyWorkspaceChanges() {
  for (const listener of listeners) {
    Promise.resolve(listener()).catch((error) => {
      log.warn("Workspace change listener failed", { error: error instanceof Error ? error.message : String(error) })
    })
  }
}

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

function directoryKey(dir: string) {
  return norm(dir.trim())
}

/** Reject paths that must never become workspace entries */
function isRejectedDir(dir: string) {
  // /workspace is the WORKSPACE_DIR inside cloud containers — never a host workspace
  if (dir === "/workspace") return true
  // __pages__ is a frontend sentinel directory — never a real workspace
  if (path.basename(dir) === "__pages__") return true
  return false
}

function storedCloudDirectory(item: Workspace) {
  return trim(item.remote_directory) || trim(item.directory) || "/workspace"
}

function mapDirectory(ws: Workspace) {
  if (ws.kind === "cloud") return
  byDir.set(ws.directory, ws.id)
}

function unmapDirectory(ws: Workspace) {
  if (ws.kind === "cloud") return
  byDir.delete(ws.directory)
}

function workspaceKey(row: Workspace) {
  return row.id
}

export function workspaceIdFromDirectoryRef(input: string | undefined) {
  const value = trim(input)
  return value && /^ws_[A-Za-z0-9_-]+$/.test(value) ? value : undefined
}

// The project's public `worktree`. Cloud workspaces have no local path, so
// their UUID id is the only stable handle. Local workspaces, however, are
// addressed by their on-disk directory throughout the frontend (routes are
// base64(directory); validWorktree requires an absolute path). Returning the
// UUID for a local project makes its `worktree` fail validation, so it gets
// filtered out of the project catalog and never appears in the sidebar.
function projectWorktree(row: Workspace) {
  if (row.kind === "cloud") return workspaceKey(row)
  return row.directory || workspaceKey(row)
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
    const state = raw as Partial<Omit<State, "workspaces"> & { workspaces: StoredWorkspace[] }>
    for (const item of state.workspaces ?? []) {
      const id = item.id
      const kind = item.kind === "cloud" ? "cloud" : "local"
      const ws: Workspace = {
        id,
        project_id: trim(item.project_id) || id,
        project_name: trim(item.project_name),
        workspace_name: trim(item.workspace_name),
        directory: kind === "cloud" ? storedCloudDirectory(item) : directoryKey(item.directory),
        kind,
        driver: item.driver,
        repo_url: trim(item.repo_url),
        repo_key: kind === "cloud" ? item.repo_key : item.repo_key ? norm(item.repo_key) : undefined,
        repo_root: kind === "cloud" ? item.repo_root : item.repo_root ? norm(item.repo_root) : undefined,
        repo_name: trim(item.repo_name),
        git_branch: trim(item.git_branch),
        git_remote: trim(item.git_remote),
        sandbox_id: trim(item.sandbox_id),
        remote_directory: trim(item.remote_directory),
        status: trim(item.status),
        created_at: item.created_at ?? Date.now(),
        updated_at: item.updated_at ?? Date.now(),
      }
      byId.set(ws.id, ws)
      mapDirectory(ws)
    }
  } catch {}
}

async function save() {
  const target = loaded ?? file()
  await fs.mkdir(path.dirname(target), { recursive: true })
  const state: State = {
    version: 4,
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
  const existing = byId.get(ws.id)
  if (existing) unmapDirectory(existing)
  byId.set(ws.id, ws)
  mapDirectory(ws)
  return ws
}

function visible(ws: Workspace) {
  if (ws.kind !== "cloud") return true
  if (!cloudAvailable(ws)) return false
  if (ws.status === "failed") return false
  if (ws.status !== "acquiring_sandbox") return true
  const lease = (() => {
    try {
      return sandboxLeaseReader?.(ws.id)
    } catch {
      return undefined
    }
  })()
  return lease?.status === "ready"
}

function cloudAvailable(ws: Workspace) {
  if (ws.kind !== "cloud") return true
  if (ws.status === "failed") return false
  if (ws.driver === "docker" && !dockerSandboxDriverEnabled()) return false
  const lease = (() => {
    try {
      return sandboxLeaseReader?.(ws.id)
    } catch {
      return undefined
    }
  })()
  if (!lease) return true
  if (lease.status === "failed") return false
  if (lease.status === "backoff" && lease.last_error) return false
  return true
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
  const key = byDir.get(directoryKey(dir))
  return key ? byId.get(key) : undefined
}

type EnsureWorkspaceInput = {
  workspaceId?: string
  org_id?: string
  project_id?: string
  project_name?: string
  workspace_name?: string
  directory: string
  kind?: "local" | "cloud"
  driver?: SandboxDriverID
  repo_url?: string
  git_branch?: string
  remote_directory?: string
  status?: string
}

export async function ensureWorkspace(input: EnsureWorkspaceInput) {
  await boot()
  if ((input.kind ?? "local") !== "local") return ensureWorkspaceUncoalesced(input)

  const directory = directoryKey(input.directory)
  if (isRejectedDir(directory) || trim(input.workspaceId) || byDir.has(directory)) {
    return ensureWorkspaceUncoalesced(input)
  }

  const pending = localFirstTouch.get(directory)
  if (pending) {
    await pending.catch(() => undefined)
    return ensureWorkspaceUncoalesced(input)
  }

  const task = ensureWorkspaceUncoalesced(input)
  localFirstTouch.set(directory, task)
  try {
    return await task
  } finally {
    if (localFirstTouch.get(directory) === task) localFirstTouch.delete(directory)
  }
}

async function ensureWorkspaceUncoalesced(input: EnsureWorkspaceInput) {
  await boot()
  const kind = input.kind ?? "local"
  const requestedId = trim(input.workspaceId)
  const directory = kind === "cloud"
    ? trim(input.remote_directory) || trim(input.directory) || "/workspace"
    : directoryKey(input.directory)
  if (kind !== "cloud" && isRejectedDir(directory)) return undefined
  let hit = requestedId && byId.has(requestedId)
    ? requestedId
    : kind === "cloud"
      ? undefined
      : byDir.get(directory)
  // Reading git identity costs four `git` subprocesses (`git()` below), and the
  // store is asked to ensure the same directory on every request that carries
  // `?directory=`. A local row already mapped to this exact directory carries
  // that identity already, so the read only tells us what is stored. It is
  // still required when the store has never mapped this directory: a new
  // workspace, or an existing id being rebound to a different directory, where
  // repo_key/repo_root/repo_name must come from the new directory's repo.
  const stored = hit ? byId.get(hit) : undefined
  const knownDirectory = kind !== "cloud" && stored?.directory === directory
  const info = kind === "cloud" || knownDirectory
    ? {} as Awaited<ReturnType<typeof git>>
    : await git(directory)
  // For cloud workspaces with no local git, derive repo_name from repo_url
  if (!knownDirectory && !info.repo_name && input.repo_url) {
    info.repo_name = trim(path.basename(input.repo_url.replace(/\/+$/, "")).replace(/\.git$/, ""))
    info.git_remote = trim(input.repo_url)
  }
  // Git discovery above is asynchronous. Two first-touch requests for the same
  // local directory can both observe a miss before either finishes discovery;
  // re-read the authoritative directory index before creating so the second
  // request adopts the workspace the first one installed.
  if (!hit && kind !== "cloud") hit = byDir.get(directory)
  const now = Date.now()
  if (hit) {
    const ws = byId.get(hit)!
    const org_id = trim(input.org_id) || ws.org_id
    const project_id = trim(input.project_id) || ws.project_id || (info.repo_key ? projectId(info.repo_key) : undefined) || ws.id
    const project_name = trim(input.project_name) || ws.project_name
    const workspace_name = trim(input.workspace_name) || ws.workspace_name
    const driver = input.driver ?? ws.driver
    const repo_url = trim(input.repo_url) || ws.repo_url
    const repo_key = info.repo_key ?? ws.repo_key
    const repo_root = info.repo_root ?? ws.repo_root
    const repo_name = info.repo_name ?? ws.repo_name
    const git_branch = trim(input.git_branch) || info.git_branch || ws.git_branch
    const git_remote = info.git_remote ?? ws.git_remote
    const remote_directory = trim(input.remote_directory) || ws.remote_directory
    const status = trim(input.status) || ws.status
    const same =
      ws.directory === directory &&
      ws.org_id === org_id &&
      ws.project_id === project_id &&
      ws.project_name === project_name &&
      ws.workspace_name === workspace_name &&
      ws.kind === kind &&
      ws.driver === driver &&
      ws.repo_url === repo_url &&
      ws.repo_key === repo_key &&
      ws.repo_root === repo_root &&
      ws.repo_name === repo_name &&
      ws.git_branch === git_branch &&
      ws.git_remote === git_remote &&
      ws.remote_directory === remote_directory &&
      ws.status === status
    if (ws.directory !== directory) byDir.delete(ws.directory)
    const next = same && ws.updated_at === now
      ? ws
      : {
          ...ws,
          directory,
          org_id,
          project_id,
          project_name,
          workspace_name,
          kind,
          driver,
          repo_url,
          repo_key,
          repo_root,
          repo_name,
          git_branch,
          git_remote,
          remote_directory,
          status,
          updated_at: now,
        }
    upsert(next)
    await save()
    return next
  }

  // New local workspaces require a git repo
  if (kind !== "cloud" && !info.repo_key) return undefined

  const id = requestedId || randomUUID()
  const ws = upsert({
    id,
    org_id: trim(input.org_id),
    project_id: trim(input.project_id) || (info.repo_key ? projectId(info.repo_key) : undefined) || id,
    project_name: trim(input.project_name),
    workspace_name: trim(input.workspace_name),
    directory,
    kind,
    driver: input.driver,
    repo_url: trim(input.repo_url),
    repo_key: info.repo_key,
    repo_root: info.repo_root,
    repo_name: info.repo_name,
    git_branch: trim(input.git_branch) || info.git_branch,
    git_remote: info.git_remote,
    remote_directory: trim(input.remote_directory),
    status: trim(input.status),
    created_at: now,
    updated_at: now,
  })
  await save()
  log.info("Workspace stored", { workspaceId: id, directory })
  notifyWorkspaceChanges()
  return ws
}

export async function bindWorkspace(id: string, dir: string) {
  await boot()
  const ws = byId.get(id)
  if (!ws) return ensureWorkspace({ workspaceId: id, directory: dir })
  if (ws.kind === "cloud") return ws
  const directory = directoryKey(dir)
  if (isRejectedDir(directory)) return undefined
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

export async function updateWorkspace(
  id: string,
  patch: Partial<Pick<Workspace, "project_name" | "workspace_name" | "driver" | "repo_url" | "remote_directory" | "status">>,
) {
  await boot()
  const ws = byId.get(id)
  if (!ws) return
  const next = upsert({
    ...ws,
    ...patch,
    updated_at: Date.now(),
  })
  await save()
  return next
}

export async function deleteWorkspace(id: string) {
  await boot()
  const ws = byId.get(id)
  if (!ws) return false
  unmapDirectory(ws)
  byId.delete(id)
  await save()
  log.info("Workspace deleted", { workspaceId: id, directory: ws.directory })
  notifyWorkspaceChanges()
  return true
}

export async function deleteWorkspaceByDirectory(dir: string) {
  await boot()
  const key = byDir.get(directoryKey(dir))
  if (!key) return false
  const ws = byId.get(key)
  if (!ws) return false
  unmapDirectory(ws)
  byId.delete(key)
  await save()
  log.info("Workspace deleted", { workspaceId: key, directory: ws.directory })
  notifyWorkspaceChanges()
  return true
}

export async function resolveWorkspace(input: { workspaceId?: string; directory?: string; create?: boolean }) {
  await boot()
  const id = input.workspaceId?.trim()
  if (id && byId.has(id)) return byId.get(id)
  const dir = input.directory?.trim()
  if (!dir) return undefined
  // Clients sometimes pass a local association UUID as `directory` when the
  // `/w/:id` route has not yet remapped to the on-disk worktree. Prefer the id
  // index over treating the UUID as a filesystem path.
  if (byId.has(dir)) return byId.get(dir)
  const directory = directoryKey(dir)
  if (isRejectedDir(directory)) return undefined
  if (!input.create) return getWorkspaceByDirectory(dir)
  return ensureWorkspace({
    workspaceId: id,
    directory: dir,
  })
}

function repoSlug(input: string | undefined) {
  if (!input) return
  const normalized = input.trim().replace(/\.git$/, "")
  const match = normalized.match(/github\.com[:/]([^/]+)\/([^/]+)$/i)
  if (match) return `${match[1]}/${match[2]}`.toLowerCase()
  return normalized.includes("/") ? normalized.split("/").slice(-2).join("/").toLowerCase() : undefined
}

function isDirectoryInside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate)
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export async function resolveWorkspaceByRepo(input: { owner: string; name: string }) {
  await boot()
  const target = `${input.owner}/${input.name}`.toLowerCase()
  return [...byId.values()].find((item) =>
    repoSlug(item.repo_url) === target
    || repoSlug(item.git_remote) === target
  )
}

export async function listProjects() {
  await boot()
  const map = new Map<string, Workspace[]>()
  for (const row of byId.values()) {
    if (!visible(row)) continue
    const key = row.project_id ?? row.id
    const list = map.get(key)
    if (list) {
      list.push(row)
      continue
    }
    map.set(key, [row])
  }

  const list = await Promise.all([...map.entries()]
    .filter(([, rows]) => !rows.every((row) => row.kind !== "cloud" && isRejectedDir(row.directory)))
    .map(async ([id, rows]) => {
      const all = [...rows].sort((a, b) => a.created_at - b.created_at)
      const root = main(all)!
      const repoRoot = root.repo_root ?? workspaceKey(root)
      const others = all.filter((row) => {
        if (row.id === root.id) return false
        // Cloud workspaces are always real sandboxes
        if (row.kind === "cloud") return true
        // Git worktrees have a different repo_root — keep them
        if (row.repo_root && row.repo_root !== repoRoot) return true
        // Subdirectories of the repo root are not real workspaces
        if (isDirectoryInside(repoRoot, row.directory)) return false
        return true
      })
      const sandboxes = others.map(workspaceKey)
      const workspaces: Record<string, Workspace> = {}
      const status = new Map(await Promise.all(
        [root, ...others].map(async (row) => [workspaceKey(row), row.kind === "cloud" ? cloudAvailable(row) : await exists(row.directory)] as const),
      ))
      for (const row of [root, ...others]) {
        workspaces[workspaceKey(row)] = {
          ...row,
          available: status.get(workspaceKey(row)) ?? true,
        }
      }

      return {
        id,
        worktree: projectWorktree(root),
        name: root.project_name || root.repo_name || root.workspace_name || (root.kind === "cloud" ? root.id : path.basename(root.directory)) || root.directory,
        kind: root.kind,
        driver: root.driver ?? null,
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
