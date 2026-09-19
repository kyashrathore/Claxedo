import fs from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"
import { realpathSync } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { dockerSandboxDriverEnabled, isSandboxDriverID, type SandboxDriverID } from "@claxedo/sandbox-contract"
import { isJsonRecord, jsonRecord, jsonString, jsonStringEntries } from "@claxedo/server-core/platform/runtime/lib/json"
import { trimToUndefined } from "@claxedo/helpers/string"
import type { HostSessionAuthority } from "@claxedo/server-core/platform/auth/authority"
import { localWorkspaceRuntimeSessionAuthority } from "@claxedo/server-core/workspace/local-runtime-port"

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
  project_icon?: { color?: string; override?: string }
  project_commands?: { start?: string }
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

/**
 * A workspace as the project catalog publishes it: the stored row plus the two
 * facts only the serving process can answer — whether its directory is still
 * there, and how the runtime that will serve it composed session access.
 */
export type CatalogWorkspace = Workspace & { session_authority?: HostSessionAuthority }

/**
 * A project: a repository and a name. Where it executes is a workspace
 * (local worktree or cloud sandbox) that carries this project's id; the
 * project itself never runs anything. `env` is the environment every cloud
 * sandbox of the project starts with — plaintext by design, see
 * `SandboxHostInput.env`; credentials the agent must not read belong in
 * Connections.
 */
export type Project = {
  id: string
  name: string
  env?: Record<string, string>
  created_at: number
  updated_at: number
}

type State = {
  version: 4
  workspaces: Workspace[]
  projects?: Project[]
}

const byId = new Map<string, Workspace>()
const byDir = new Map<string, string>()
const projectsById = new Map<string, Project>()
const listeners = new Set<() => void | Promise<void>>()
const localFirstTouch = new Map<string, Promise<Workspace | undefined>>()

let ready: Promise<void> | undefined
let loaded: string | undefined
let saving = Promise.resolve()

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
  const value = trimToUndefined(input)
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
    return trimToUndefined(stdout)
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
    ? trimToUndefined(path.basename(remote.replace(/\/+$/, "")).replace(/\.git$/, ""))
    : trimToUndefined(path.basename(repo_root))
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

/** A `{ color?, override? }` / `{ start? }` style sub-object of a stored record. */
function textFields<Key extends string>(value: unknown, keys: readonly Key[]): Partial<Record<Key, string>> | undefined {
  const row = jsonRecord(value)
  if (!row) return undefined
  const out: Partial<Record<Key, string>> = {}
  for (const key of keys) {
    const entry = row[key]
    if (typeof entry === "string") out[key] = entry
  }
  return out
}

/** A stored sandbox driver id, when the file names one this build knows. */
function driverId(value: unknown): SandboxDriverID | undefined {
  const id = jsonString(value)
  return id && isSandboxDriverID(id) ? id : undefined
}

/** A stored timestamp, or now when the record predates the field or carries a bad one. */
function storedTime(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now()
}

async function load(target: string) {
  try {
    const state = jsonRecord(JSON.parse(await fs.readFile(target, "utf-8")))
    const rows = (key: string) => {
      const value = state?.[key]
      return Array.isArray(value) ? value.filter(isJsonRecord) : []
    }
    for (const item of rows("projects")) {
      const id = trimToUndefined(jsonString(item.id))
      const name = trimToUndefined(jsonString(item.name))
      if (!id || !name) continue
      projectsById.set(id, {
        id,
        name,
        env: envRecord(item.env),
        created_at: storedTime(item.created_at),
        updated_at: storedTime(item.updated_at),
      })
    }
    for (const item of rows("workspaces")) {
      const id = jsonString(item.id)
      if (!id) continue
      const kind = item.kind === "cloud" ? "cloud" : "local"
      const directory = jsonString(item.directory)
      const repoKey = trimToUndefined(jsonString(item.repo_key))
      const repoRoot = trimToUndefined(jsonString(item.repo_root))
      const remoteDirectory = trimToUndefined(jsonString(item.remote_directory))
      const storedDirectory = kind === "cloud" ? (remoteDirectory ?? trimToUndefined(directory) ?? "/workspace") : directory
      if (!storedDirectory) continue
      const ws: Workspace = {
        id,
        org_id: trimToUndefined(jsonString(item.org_id)),
        project_id: trimToUndefined(jsonString(item.project_id)) || id,
        project_name: trimToUndefined(jsonString(item.project_name)),
        project_icon: textFields(item.project_icon, ["color", "override"]),
        project_commands: textFields(item.project_commands, ["start"]),
        workspace_name: trimToUndefined(jsonString(item.workspace_name)),
        directory: kind === "cloud" ? storedDirectory : directoryKey(storedDirectory),
        kind,
        driver: driverId(item.driver),
        repo_url: trimToUndefined(jsonString(item.repo_url)),
        repo_key: kind === "cloud" ? repoKey : repoKey ? norm(repoKey) : undefined,
        repo_root: kind === "cloud" ? repoRoot : repoRoot ? norm(repoRoot) : undefined,
        repo_name: trimToUndefined(jsonString(item.repo_name)),
        git_branch: trimToUndefined(jsonString(item.git_branch)),
        git_remote: trimToUndefined(jsonString(item.git_remote)),
        sandbox_id: trimToUndefined(jsonString(item.sandbox_id)),
        remote_directory: remoteDirectory,
        status: trimToUndefined(jsonString(item.status)),
        created_at: storedTime(item.created_at),
        updated_at: storedTime(item.updated_at),
      }
      byId.set(ws.id, ws)
      mapDirectory(ws)
    }
  } catch {}
}

async function save() {
  const target = loaded ?? file()
  const state: State = {
    version: 4,
    workspaces: [...byId.values()].sort((a, b) => a.created_at - b.created_at),
    projects: [...projectsById.values()].sort((a, b) => a.created_at - b.created_at),
  }
  const contents = JSON.stringify(state, null, 2) + "\n"
  const pending = saving.catch(() => undefined).then(async () => {
    await fs.mkdir(path.dirname(target), { recursive: true })
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, contents)
      await fs.rename(temporary, target)
    } finally {
      await fs.unlink(temporary).catch(() => undefined)
    }
  })
  saving = pending
  await pending
}

async function boot() {
  const target = file()
  const exists = () => fs.access(target).then(() => true, () => false)
  let fresh = await exists()
  if (!fresh && ready && loaded === target) {
    // A save lands through a temp-file rename, so the file is absent while the
    // first save of a new store is in flight. Only a file still missing once
    // every queued save has settled was deleted underneath a loaded store.
    await saving.catch(() => undefined)
    fresh = await exists()
  }
  if (!ready || loaded !== target || !fresh) {
    loaded = target
    byId.clear()
    byDir.clear()
    projectsById.clear()
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
  const rows = [...byId.values()].filter((row) => row.project_id === trimToUndefined(id))
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

function envRecord(value: unknown): Record<string, string> | undefined {
  const entries = jsonStringEntries(value)
  return Object.keys(entries).length ? entries : undefined
}

export async function ensureWorkspace(input: EnsureWorkspaceInput) {
  await boot()
  if ((input.kind ?? "local") !== "local") return ensureWorkspaceUncoalesced(input)

  const directory = directoryKey(input.directory)
  if (isRejectedDir(directory) || trimToUndefined(input.workspaceId) || byDir.has(directory)) {
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
  const requestedId = trimToUndefined(input.workspaceId)
  const directory = kind === "cloud"
    ? trimToUndefined(input.remote_directory) || trimToUndefined(input.directory) || "/workspace"
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
    info.repo_name = trimToUndefined(path.basename(input.repo_url.replace(/\/+$/, "")).replace(/\.git$/, ""))
    info.git_remote = trimToUndefined(input.repo_url)
  }
  // Git discovery above is asynchronous. Two first-touch requests for the same
  // local directory can both observe a miss before either finishes discovery;
  // re-read the authoritative directory index before creating so the second
  // request adopts the workspace the first one installed.
  if (!hit && kind !== "cloud") hit = byDir.get(directory)
  const now = Date.now()
  if (hit) {
    const ws = byId.get(hit)!
    const org_id = trimToUndefined(input.org_id) || ws.org_id
    const project_id = trimToUndefined(input.project_id) || ws.project_id || (info.repo_key ? projectId(info.repo_key) : undefined) || ws.id
    const project_name = trimToUndefined(input.project_name) || ws.project_name
    const workspace_name = trimToUndefined(input.workspace_name) || ws.workspace_name
    const driver = input.driver ?? ws.driver
    if (kind === "cloud" && !driver) return undefined
    const repo_url = trimToUndefined(input.repo_url) || ws.repo_url
    const repo_key = info.repo_key ?? ws.repo_key
    const repo_root = info.repo_root ?? ws.repo_root
    const repo_name = info.repo_name ?? ws.repo_name
    const git_branch = trimToUndefined(input.git_branch) || info.git_branch || ws.git_branch
    const git_remote = info.git_remote ?? ws.git_remote
    const remote_directory = trimToUndefined(input.remote_directory) || ws.remote_directory
    const status = trimToUndefined(input.status) || ws.status
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
  // A cloud row's placement IS its driver: the provisioner owns the machine it
  // provisions. Stored without one the row names no machine at all.
  if (kind === "cloud" && !input.driver) return undefined

  const id = requestedId || randomUUID()
  const ws = upsert({
    id,
    org_id: trimToUndefined(input.org_id),
    project_id: trimToUndefined(input.project_id) || (info.repo_key ? projectId(info.repo_key) : undefined) || id,
    project_name: trimToUndefined(input.project_name),
    workspace_name: trimToUndefined(input.workspace_name),
    directory,
    kind,
    driver: input.driver,
    repo_url: trimToUndefined(input.repo_url),
    repo_key: info.repo_key,
    repo_root: info.repo_root,
    repo_name: info.repo_name,
    git_branch: trimToUndefined(input.git_branch) || info.git_branch,
    git_remote: info.git_remote,
    remote_directory: trimToUndefined(input.remote_directory),
    status: trimToUndefined(input.status),
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
  patch: Partial<
    Pick<Workspace, "project_name" | "workspace_name" | "driver" | "repo_url" | "remote_directory" | "status">
  >,
) {
  await boot()
  const ws = byId.get(id)
  if (!ws) return undefined
  const next = upsert({
    ...ws,
    ...patch,
    updated_at: Date.now(),
  })
  await save()
  return next
}

export type ProjectMetadataUpdate = {
  name?: string
  icon?: { color?: string; override?: string }
  commands?: { start?: string }
}

function projectMetadata(root: Workspace): ProjectMetadataUpdate {
  return {
    ...(root.project_name ? { name: root.project_name } : {}),
    ...(root.project_icon ? { icon: root.project_icon } : {}),
    ...(root.project_commands ? { commands: root.project_commands } : {}),
  }
}

export async function getProjectMetadata(projectId: string) {
  const root = await getProjectWorkspace(projectId)
  return root ? projectMetadata(root) : undefined
}

export async function updateProjectMetadata(projectId: string, patch: ProjectMetadataUpdate) {
  const workspace = await getProjectWorkspace(projectId)
  const root = workspace && byId.get(workspace.id)
  if (!root) return undefined
  upsert({
    ...root,
    ...(patch.name !== undefined ? { project_name: trimToUndefined(patch.name) } : {}),
    ...(patch.icon ? { project_icon: { ...root.project_icon, ...patch.icon } } : {}),
    ...(patch.commands ? { project_commands: { ...root.project_commands, ...patch.commands } } : {}),
    updated_at: Date.now(),
  })
  await save()
  notifyWorkspaceChanges()
  return (await listProjects()).find((project) => project.id === projectId)
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
  const directory = directoryKey(dir)
  if (isRejectedDir(directory)) return undefined
  if (!input.create) return getWorkspaceByDirectory(dir)
  return ensureWorkspace({
    workspaceId: id,
    directory: dir,
  })
}

function repoSlug(input: string | undefined): string | undefined {
  if (!input) return undefined
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
      const root = main(all)
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
      const workspaces: Record<string, CatalogWorkspace> = {}
      const status = new Map(await Promise.all(
        [root, ...others].map(async (row) => [workspaceKey(row), row.kind === "cloud" ? cloudAvailable(row) : await exists(row.directory)] as const),
      ))
      const sessionAuthority = localWorkspaceRuntimeSessionAuthority()
      for (const row of [root, ...others]) {
        workspaces[workspaceKey(row)] = {
          ...row,
          available: status.get(workspaceKey(row)) ?? true,
          // Declared only for the workspaces this process actually serves. A
          // `cloud` row names a runtime on another machine, whose composition
          // this server has no standing to state; its client learns that one
          // from the connection mint instead.
          ...(row.kind === "local" && sessionAuthority ? { session_authority: sessionAuthority } : {}),
        }
      }

      return {
        id,
        worktree: projectWorktree(root),
        name: root.repo_name || root.workspace_name || (root.kind === "cloud" ? root.id : path.basename(root.directory)) || root.directory,
        ...projectMetadata(root),
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

// ── Projects ────────────────────────────────────────────────────────────────

export async function listProjectRecords(): Promise<Project[]> {
  await boot()
  return [...projectsById.values()].sort((a, b) => a.created_at - b.created_at)
}

export async function getProjectRecord(id: string | undefined): Promise<Project | undefined> {
  await boot()
  const key = trimToUndefined(id)
  return key ? projectsById.get(key) : undefined
}

/** Names are unique per server, compared case-insensitively. */
export async function findProjectRecordByName(name: string): Promise<Project | undefined> {
  await boot()
  const wanted = name.trim().toLowerCase()
  return [...projectsById.values()].find((project) => project.name.toLowerCase() === wanted)
}

/** Creates or renames a project record; the workspace rows carrying `id` are its executions. */
export async function upsertProjectRecord(input: { id: string; name: string; env?: Record<string, string> }): Promise<Project> {
  await boot()
  const id = trimToUndefined(input.id)
  const name = trimToUndefined(input.name)
  if (!id || !name) throw new Error("project id and name are required")
  const now = Date.now()
  const existing = projectsById.get(id)
  const next: Project = {
    id,
    name,
    env: input.env === undefined ? existing?.env : envRecord(input.env),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  }
  projectsById.set(id, next)
  await save()
  notifyWorkspaceChanges()
  return next
}

/** The environment every cloud sandbox of the project starts with. */
export async function projectEnv(projectId: string | undefined): Promise<Record<string, string> | undefined> {
  return (await getProjectRecord(projectId))?.env
}
