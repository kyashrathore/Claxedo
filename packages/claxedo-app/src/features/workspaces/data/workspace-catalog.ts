import type { ClaxedoProject as Project, ClaxedoWorkspaceInventoryEntry } from "@/platform/api/claxedo-api-types"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { normalizeProjectList, readProjectCatalog } from "@/platform/query/control-plane"
import { authFetch as defaultAuthFetch } from "@/platform/api/api"
import { centralTransportForServer } from "@/platform/runtime/transport"
import { readArray } from "@/lib/record"
import { signedAccountRun } from "@/platform/account/hosted-control-call"
import { decodeHostedResult } from "@/platform/account/hosted-operations"
import {
  backingHostKind,
  controlPlaneRowPlacement,
  inventoryKindWord,
  type RelayHostKind,
} from "@/platform/runtime/placement-wire"
import { workspaceListUrl } from "@/platform/runtime/agent/workspace-control-routes"
import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"

/**
 * The workspaces the current principal can see, as one query.
 *
 * Two sources feed it and neither owns the result on its own:
 *
 * - the central's own `/project`, when that central answers for its own
 *   workspaces (the loopback daemon, and demo mode's in-page mock server) —
 *   the workspaces read directly rather than over a relay;
 * - the control plane's workspace list, one call per host kind (the
 *   provisioner's and the enrolled machines'), when a principal is signed in —
 *   the cloud sandboxes and the machines reachable over the relay.
 *
 * `mergeWorkspaceCatalog` folds them into one row per workspace, preferring the
 * direct read: a workspace this machine both serves and publishes is ONE row
 * placed on this machine, because reading it through its own tunnel is a round
 * trip to itself.
 */

/** A workspace row inside a catalog project, keyed by its project ref. */
export type WorkspaceCatalogEntry = {
  id: string
  workspaceId: string
  /**
   * The same three placement words `ClaxedoWorkspaceInventoryEntry` declares.
   * Widening this to `string` made a catalog row something an inventory row
   * could never be, which is what forced the assertions this file used to
   * carry.
   */
  kind: NonNullable<ClaxedoWorkspaceInventoryEntry["kind"]>
  /** The placement the control plane states; see `ClaxedoWorkspaceInventoryEntry`. */
  placement?: { host_enrollment_id?: string }
  /** What this principal may do here, as the control plane reports it. */
  role?: string
  /** The serving host's state, as the control plane reports it. */
  status?: string
  /**
   * Whether a live host is currently serving this workspace, as the
   * control plane reports it (an active enrollment with an unexpired lease that
   * acked this workspace). Absent for every other kind — reachability is only a
   * question about a machine someone owns. The rail says "host offline" from
   * this, before any pane opens the workspace.
   */
  hostOnline?: boolean
  workspace_name?: string
  /**
   * The address every read of this workspace is scoped by — see
   * `workspaceRowDirectory`. Never a path on the serving host.
   */
  directory: string
  /**
   * Where the serving host keeps this workspace on ITS OWN filesystem, as the
   * control plane reports it. Display and metadata only: it names a directory
   * on another machine, so it is what the UI shows as the workspace's
   * location, never what a request is scoped by.
   */
  remote_directory?: string
  repo_url?: string
  repo_name?: string
}

export type WorkspaceCatalogProject = Project & {
  workspaces?: Record<string, WorkspaceCatalogEntry>
}

type ProjectListClient = {
  project: { list: () => Promise<{ data?: Project[] }> }
}

function txt(input: unknown) {
  return typeof input === "string" && input ? input : undefined
}

/**
 * Whether the central server answers for its own workspaces on `/project`.
 * True for the loopback daemon, which owns a project inventory and no control
 * plane.
 */
function centralOwnsProjects(serverUrl: string | undefined) {
  return centralTransportForServer(serverUrl) === "loopback"
}

/**
 * The address a control-plane workspace is read, routed and keyed by.
 *
 * Every row this grouping sees is relay-backed — the control plane answers for
 * the provisioner's machines and for enrolled ones, and both are served by
 * ANOTHER machine. The path such a row reports (`remote_directory`) names a directory
 * on that machine's filesystem, so scoping a request by it asks a server about
 * a path it cannot resolve. The signed workspace id is the one identity both
 * sides agree on, in the same `workspace:<id>` form `sessionRowDirectory`
 * stamps on every session row of such a workspace — so a row and its sessions
 * name the workspace identically.
 *
 * The host's path is kept on the row as `remote_directory`: the workspace's
 * LOCATION, which the UI shows and nothing addresses by.
 */
function workspaceRowDirectory(workspaceId: string) {
  return `workspace:${workspaceId}`
}

function rowPlacement(row: Record<string, unknown>): { host_enrollment_id?: string } {
  const placement = controlPlaneRowPlacement(row)
  const enrollmentId = placement?.host.kind === "machine" ? placement.host.enrollmentId : undefined
  return enrollmentId ? { host_enrollment_id: enrollmentId } : {}
}

function workspaceRowHostDirectory(row: Record<string, unknown>) {
  return txt(row.remote_directory) ?? txt(row.remoteDirectory) ?? txt(row.directory)
}

function workspaceRepoUrl(row: Record<string, unknown>) {
  return txt(row.repo_url) ?? txt(row.repoUrl) ?? txt(row.git_remote) ?? txt(row.gitRemote)
}

/**
 * "owner/repo" from a git remote — the same derivation the rail uses for a
 * project label.
 */
function ownerRepo(remote: string | undefined) {
  if (!remote) return undefined
  return remote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1]
}

/**
 * The PROJECT's name. `display_name` is the WORKSPACE name and the hosted
 * create dialog posts `workspaceName: "main"`, so preferring it labels every
 * hosted cloud project "main"; the repo identity is what names the project.
 * Falls through to the project id, never to the host's path — a hosted cloud
 * workspace's `remote_directory` is the literal string "/workspace".
 */
function projectDisplayName(row: Record<string, unknown>, projectID: string) {
  return txt(row.project_name) ??
    txt(row.projectName) ??
    txt(row.repo_name) ??
    txt(row.repoName) ??
    ownerRepo(workspaceRepoUrl(row)) ??
    txt(row.display_name) ??
    txt(row.displayName) ??
    projectID
}

/**
 * Group raw control-plane workspace rows into catalog projects.
 *
 * `role` and `status` come straight off the row: the control plane is the
 * authority for what this principal may do with a workspace and for the state
 * of the host serving it, and the rail must be able to say so before any pane
 * opens the workspace.
 */
export function controlPlaneCatalogProjects(input: { workspaces: unknown[] }): WorkspaceCatalogProject[] {
  const groups = new Map<string, {
    id: string
    name: string
    directories: string[]
    workspaces: Record<string, WorkspaceCatalogEntry>
    created: number
    updated: number
  }>()
  for (const workspace of input.workspaces) {
    const row = asRecord(workspace)
    if (!row) continue
    const workspaceId = txt(row.workspace_id) ?? txt(row.workspaceId)
    if (!workspaceId) continue
    const directory = workspaceRowDirectory(workspaceId)
    const hostDirectory = workspaceRowHostDirectory(row)
    const projectID = txt(row.project_id) ?? txt(row.projectID) ?? workspaceId
    const workspaceName = txt(row.workspace_name) ??
      txt(row.workspaceName) ??
      txt(row.display_name) ??
      txt(row.displayName) ??
      workspaceId
    const created = asFiniteNumber(row.created_at) ?? asFiniteNumber(row.createdAt) ?? 0
    const updated = asFiniteNumber(row.updated_at) ?? asFiniteNumber(row.updatedAt) ?? created
    const group = groups.get(projectID) ?? {
      id: projectID,
      name: projectDisplayName(row, projectID),
      directories: [],
      workspaces: {},
      created,
      updated,
    }
    // Rows within a project are not uniform: only some carry repo identity. A
    // group opened by a bare row still has the raw project id as its name, so
    // let a later row that DOES know the repo upgrade it.
    if (group.name === projectID) group.name = projectDisplayName(row, projectID)
    group.directories.push(directory)
    group.created = Math.min(group.created, created)
    group.updated = Math.max(group.updated, updated)
    group.workspaces[directory] = {
      id: workspaceId,
      workspaceId,
      kind: controlPlaneRowKind(row),
      placement: rowPlacement(row),
      ...(txt(row.role) ? { role: txt(row.role) } : {}),
      ...(txt(row.status) ? { status: txt(row.status) } : {}),
      ...(typeof row.host_online === "boolean" ? { hostOnline: row.host_online } : {}),
      workspace_name: workspaceName,
      directory,
      ...(hostDirectory ? { remote_directory: hostDirectory } : {}),
      repo_url: workspaceRepoUrl(row),
      repo_name: txt(row.repo_name) ?? txt(row.repoName),
    }
    groups.set(projectID, group)
  }
  return [...groups.values()].map((group): WorkspaceCatalogProject => ({
    id: group.id,
    name: group.name,
    worktree: group.directories[0] ?? group.id,
    sandboxes: group.directories,
    workspaces: group.workspaces,
    time: {
      created: group.created,
      updated: group.updated,
    },
  }))
}

/**
 * The workspace rows on a project, read through the inventory shape both
 * sources share. The merge only ever reads `id`/`workspaceId` here, which the
 * inventory row already declares — so no narrowing of a direct project's rows
 * into catalog rows is needed, and none is asserted.
 */
/**
 * The widest window either side knows about: earliest creation, latest update.
 *
 * Either side may carry no `time` at all — the embedded OpenCode engine's
 * project payload has none — in which case the other side's is the whole
 * answer.
 */
function mergeProjectTime(local: Project["time"], central: Project["time"]): Project["time"] {
  if (!local) return central
  if (!central) return local
  return {
    created: Math.min(local.created, central.created),
    updated: Math.max(local.updated, central.updated),
    initialized: local.initialized ?? central.initialized,
  }
}

function catalogWorkspaces(project: Project) {
  return project.workspaces ?? {}
}

/**
 * One row per workspace, direct read preferred.
 *
 * Every workspace id and directory the DIRECT source already carries is an
 * identity this machine serves itself. A control-plane row for one of those is
 * the same workspace seen from the other side (sharing a local workspace
 * creates a control-plane row under the same id, with `/workspace` as its
 * remote placeholder), so it is dropped rather than rendered beside the direct
 * row — and its sessions are read from the daemon, not through its own tunnel.
 */
export function mergeWorkspaceCatalog(direct: Project[], remote: WorkspaceCatalogProject[]) {
  if (remote.length === 0) return direct
  const directIds = new Set<string>()
  for (const project of direct) {
    directIds.add(project.id)
    for (const [key, workspace] of Object.entries(catalogWorkspaces(project))) {
      directIds.add(key)
      for (const id of [workspace.id, workspace.workspaceId]) if (id) directIds.add(id)
    }
  }
  const servedDirectly = (ref: string) => directIds.has(ref) || directIds.has(ref.replace(/^workspace:/, ""))
  const remoteOnly = (project: WorkspaceCatalogProject) => {
    const kept = Object.fromEntries(
      Object.entries(catalogWorkspaces(project)).filter(
        ([key, workspace]) => !servedDirectly(key) && !(workspace.id && servedDirectly(workspace.id)),
      ),
    )
    return {
      workspaces: kept,
      sandboxes: (project.sandboxes ?? []).filter((sandbox) => !servedDirectly(sandbox)),
    }
  }

  const remoteByID = new Map(remote.map((project) => [project.id, project]))
  const seen = new Set<string>()
  const merged = direct.map((project) => {
    const remoteProject = remoteByID.get(project.id)
    if (!remoteProject) return project
    seen.add(project.id)
    const additions = remoteOnly(remoteProject)
    return {
      ...project,
      // A project id is a present-but-meaningless string that `??` happily
      // preserves, so a placeholder name (name === id) must lose to a real
      // repo-derived name arriving on the control-plane side.
      name: (project.name && project.name !== project.id ? project.name : undefined) ?? remoteProject.name,
      sandboxes: [...new Set([...(project.sandboxes ?? []), ...additions.sandboxes])],
      workspaces: {
        ...catalogWorkspaces(project),
        ...additions.workspaces,
      },
      time: mergeProjectTime(project.time, remoteProject.time),
    }
  })
  return [
    ...merged,
    ...remote.flatMap((project) => {
      if (seen.has(project.id)) return []
      const additions = remoteOnly(project)
      if (Object.keys(additions.workspaces).length === 0) return []
      return [{ ...project, workspaces: additions.workspaces, sandboxes: additions.sandboxes }]
    }),
  ]
}

async function listControlPlaneWorkspaces(input: {
  host: RelayHostKind
  serverUrl?: string
  request: typeof fetch
}) {
  const run = await signedAccountRun()
  if (run) {
    const operation = input.host === "provisioner" ? "workspace.list.provisioner" : "workspace.list.machine"
    const workspaces = readArray(decodeHostedResult(operation, await run(operation, {})), "workspaces")
    if (!workspaces) throw new Error(`${operation} returned an invalid workspaces payload`)
    return workspaces
  }
  const res = await input.request(workspaceListUrl({ baseUrl: input.serverUrl, host: input.host }), {
    headers: { Accept: "application/json" },
  })
  if (!res.ok) throw new Error(`Control-plane ${input.host} workspace list failed with ${res.status}`)
  const workspaces = readArray(await res.json(), "workspaces")
  if (!workspaces) {
    throw new Error(`Control-plane ${input.host} workspace list returned an invalid workspaces payload`)
  }
  return workspaces
}

/**
 * The provisioner's workspaces and the enrolled machines' are independent
 * lists on independent routes/operations — nothing here reads one to form the
 * other — so they run concurrently instead of paying two serial round trips.
 */
async function controlPlaneCatalog(input: { serverUrl?: string; request: typeof fetch }) {
  const [provisioner, machines] = await Promise.all([
    listControlPlaneWorkspaces({ host: "provisioner", ...input }),
    listControlPlaneWorkspaces({ host: "machine", ...input }),
  ])
  return controlPlaneCatalogProjects({ workspaces: [...provisioner, ...machines] })
}

export type WorkspaceCatalogQueryInput = {
  baseUrl?: string
  client: ProjectListClient
  request?: typeof fetch
  /** Whether a signed principal exists to present to the control plane. */
  signedAccess: boolean
}

export function workspaceCatalogQueryKey(baseUrl?: string) {
  return queryKeys.controlPlane.projects(baseUrl)
}

export function workspaceCatalogQuery(input: WorkspaceCatalogQueryInput) {
  const direct = centralOwnsProjects(input.baseUrl)
  return {
    queryKey: workspaceCatalogQueryKey(input.baseUrl),
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<Project[]> => {
      const request = input.request ?? defaultAuthFetch
      const own = direct ? normalizeProjectList((await input.client.project.list()).data) : []
      if (!input.signedAccess) return own
      // Where the central owns no projects the control plane is the ONLY
      // source, so its failure is the query's failure. Where it does, it has
      // already answered for the workspaces this machine serves; a
      // control-plane outage must not erase them, so the remote half is
      // reported as absent rather than fatal.
      if (!direct) return await controlPlaneCatalog({ serverUrl: input.baseUrl, request })
      const remote = await controlPlaneCatalog({ serverUrl: input.baseUrl, request }).catch(() => [])
      return mergeWorkspaceCatalog(own, remote)
    },
  }
}

/**
 * The one place the catalog cache is written outside its own `queryFn`.
 *
 * Global `project.*` events carry an already-authoritative row; applying it
 * here keeps the rail on a single writer instead of a per-event refetch.
 */
export function applyWorkspaceCatalog(input: {
  baseUrl?: string
  next: Project[] | ((projects: Project[]) => Project[])
}) {
  const key = workspaceCatalogQueryKey(input.baseUrl)
  const current = queryClient.getQueryData<Project[]>(key) ?? []
  queryClient.setQueryData(key, typeof input.next === "function" ? input.next(current) : input.next)
}

export function readWorkspaceCatalog(baseUrl?: string) {
  return readProjectCatalog(baseUrl)
}

/** Re-read the catalog from its sources (workspace created, re-homed, or a global `project.*`/`workspace.*` event). */
export async function refreshWorkspaceCatalog(input: WorkspaceCatalogQueryInput) {
  const options = workspaceCatalogQuery(input)
  await queryClient.invalidateQueries({ queryKey: options.queryKey })
  return await queryClient.fetchQuery(options)
}

function controlPlaneRowKind(row: Record<string, unknown>): WorkspaceCatalogEntry["kind"] {
  const kind = backingHostKind(row.backing)
  if (!kind) {
    // A row whose placement this build cannot interpret must not be rendered as
    // though it could be opened.
    const backing = txt(row.backing)
    throw new Error(`Control-plane workspace row states no placement${backing ? `: ${backing}` : ""}`)
  }
  // A catalog row sits in the same inventory map as the central's own rows, so
  // it carries the same wire word; readers narrow both with `inventoryHostKind`.
  return inventoryKindWord(kind)
}
