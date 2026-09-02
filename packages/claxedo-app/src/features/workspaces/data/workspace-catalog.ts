import type { Project } from "@opencode-ai/sdk/v2/client"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { normalizeProjectList } from "@/platform/query/control-plane"
import { authFetch as defaultAuthFetch } from "@/platform/api/api"
import { centralTransportForServer } from "@/platform/runtime/transport"
import { isDemoMode } from "@/lib/runtime-mode"
import { signedAccountRun } from "@/platform/account/hosted-control-call"
import { decodeHostedResult } from "@/platform/account/hosted-operations"
import type { SignedWorkspaceKind } from "@/platform/runtime/agent/workspace-kind"
import { workspaceListUrl } from "@/platform/runtime/agent/workspace-control-routes"

/**
 * The workspaces the current principal can see, as one query.
 *
 * Two sources feed it and neither owns the result on its own:
 *
 * - the central's own `/project`, when that central answers for its own
 *   workspaces (the loopback daemon, and demo mode's in-page mock server) —
 *   the workspaces read directly rather than over a relay;
 * - the control plane's workspace list (`/api/workspace?access=cloud` and
 *   `?access=user-hosted`, or the desktop account bridge's
 *   `workspace.list.cloud` / `workspace.list.userHosted`), when a principal is
 *   signed in — the cloud sandboxes and the machines reachable over the relay.
 *
 * `mergeWorkspaceCatalog` folds them into one row per workspace, preferring the
 * direct read: a workspace this machine both serves and publishes as
 * user-hosted is ONE `local` row, because reading it through its own tunnel is
 * a round trip to itself.
 */

/** A workspace row inside a catalog project, keyed by its project ref. */
export type WorkspaceCatalogEntry = {
  id: string
  workspaceId: string
  kind: string
  /** What this principal may do here, as the control plane reports it. */
  role?: string
  /** The serving host's state, as the control plane reports it. */
  status?: string
  workspace_name?: string
  directory: string
  repo_url?: string
  repo_name?: string
}

export type WorkspaceCatalogProject = Project & {
  workspaces?: Record<string, WorkspaceCatalogEntry>
}

type ProjectListClient = {
  project: { list: () => Promise<{ data?: Project[] }> }
}

function rec(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
}

function txt(input: unknown) {
  return typeof input === "string" && input ? input : undefined
}

function num(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

/**
 * Whether the central server answers for its own workspaces on `/project`.
 *
 * True for the loopback daemon, and for demo mode — served from an ordinary
 * https origin but backed entirely by the in-page mock server, which owns a
 * project inventory and no control plane. `platform/api/api.ts` already routes
 * the demo's base URL the same way.
 */
function centralOwnsProjects(serverUrl: string | undefined) {
  return centralTransportForServer(serverUrl) === "loopback" || isDemoMode()
}

function workspaceRowDirectory(row: Record<string, unknown>, workspaceId: string) {
  return txt(row.remote_directory) ?? txt(row.remoteDirectory) ?? txt(row.directory) ?? `workspace:${workspaceId}`
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
 * Falls through to the project id, never to the directory — a hosted cloud
 * workspace's directory is the literal string "/workspace".
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
    const row = rec(workspace)
    if (!row) continue
    const workspaceId = txt(row.workspace_id) ?? txt(row.workspaceId)
    if (!workspaceId) continue
    const directory = workspaceRowDirectory(row, workspaceId)
    const projectID = txt(row.project_id) ?? txt(row.projectID) ?? workspaceId
    const workspaceName = txt(row.workspace_name) ??
      txt(row.workspaceName) ??
      txt(row.display_name) ??
      txt(row.displayName) ??
      workspaceId
    const created = num(row.created_at) ?? num(row.createdAt) ?? 0
    const updated = num(row.updated_at) ?? num(row.updatedAt) ?? created
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
      kind: txt(row.access) ?? txt(row.backing) ?? "cloud",
      ...(txt(row.role) ? { role: txt(row.role) } : {}),
      ...(txt(row.status) ? { status: txt(row.status) } : {}),
      workspace_name: workspaceName,
      directory,
      repo_url: workspaceRepoUrl(row),
      repo_name: txt(row.repo_name) ?? txt(row.repoName),
    }
    groups.set(projectID, group)
  }
  return [...groups.values()].map((group) => ({
    id: group.id,
    name: group.name,
    worktree: group.directories[0] ?? group.id,
    sandboxes: group.directories,
    workspaces: group.workspaces,
    time: {
      created: group.created,
      updated: group.updated,
    },
  })) as WorkspaceCatalogProject[]
}

function catalogWorkspaces(project: Project) {
  return (project as WorkspaceCatalogProject).workspaces ?? {}
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
      time: {
        created: Math.min(project.time?.created ?? remoteProject.time.created, remoteProject.time.created),
        updated: Math.max(project.time?.updated ?? remoteProject.time.updated, remoteProject.time.updated),
        initialized: project.time?.initialized ?? remoteProject.time.initialized,
      },
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
  access: SignedWorkspaceKind
  serverUrl?: string
  request: typeof fetch
}) {
  const run = await signedAccountRun()
  if (run) {
    const operation = input.access === "cloud" ? "workspace.list.cloud" : "workspace.list.userHosted"
    const body = decodeHostedResult<{ workspaces: unknown[] }>(operation, await run(operation, {}))
    if (!Array.isArray(body.workspaces)) throw new Error(`${operation} returned an invalid workspaces payload`)
    return body.workspaces
  }
  const res = await input.request(workspaceListUrl({ baseUrl: input.serverUrl, access: input.access }), {
    headers: { Accept: "application/json" },
  })
  if (!res.ok) throw new Error(`Control-plane ${input.access} workspace list failed with ${res.status}`)
  const body = await res.json()
  if (!Array.isArray(body?.workspaces)) {
    throw new Error(`Control-plane ${input.access} workspace list returned an invalid workspaces payload`)
  }
  return body.workspaces as unknown[]
}

/**
 * Cloud and user-hosted are independent access lists on independent
 * routes/operations — nothing here reads one to form the other — so they run
 * concurrently instead of paying two serial round trips.
 */
async function controlPlaneCatalog(input: { serverUrl?: string; request: typeof fetch }) {
  const [cloud, userHosted] = await Promise.all([
    listControlPlaneWorkspaces({ access: "cloud", ...input }),
    listControlPlaneWorkspaces({ access: "user-hosted", ...input }),
  ])
  return controlPlaneCatalogProjects({ workspaces: [...cloud, ...userHosted] })
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
    /**
     * A catalog that came back empty is not evidence that the principal lost
     * every workspace — an unauthenticated refetch, a control plane mid-deploy
     * and a genuinely emptied account all answer `[]`. The rail IS this query,
     * so replacing a populated catalog with an empty one empties the sidebar.
     * Keep what is already known; a real removal arrives as a rewritten list.
     */
    structuralSharing: (previous: unknown, next: unknown) => {
      const before = (previous ?? []) as Project[]
      const after = (next ?? []) as Project[]
      return after.length === 0 && before.length > 0 ? before : after
    },
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
  return queryClient.getQueryData<Project[]>(workspaceCatalogQueryKey(baseUrl)) ?? []
}

/** Re-read the catalog from its sources (workspace created, re-homed, or a global `project.*`/`workspace.*` event). */
export async function refreshWorkspaceCatalog(input: WorkspaceCatalogQueryInput) {
  const options = workspaceCatalogQuery(input)
  await queryClient.invalidateQueries({ queryKey: options.queryKey })
  return await queryClient.fetchQuery(options)
}
