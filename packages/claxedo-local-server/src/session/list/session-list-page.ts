import { HTTPException } from "hono/http-exception"
import { machineDisplayName } from "@claxedo/helpers/machine-name"
import type { ExecutionAvailability } from "@claxedo/agent-runtime-contract"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { listSessionNavigationMetas, countSessionNavigation } from "@claxedo/server-core/session/meta/index"
import {
  buildSessionListResponse,
  sessionListKeysetPage,
  sessionListStorePageFilter,
  type SessionListQuery,
  type SessionListResponse,
} from "@claxedo/server-core/session/navigation-list"
import type { SessionMeta } from "@claxedo/server-core/session/meta/index"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { getProjectRecord } from "@claxedo/server-core/workspace/store/index"
import { readRuntimeSessionActivity, type RuntimeSessionActivity, type RuntimeStatusRead } from "../runtime-activity"

export type SessionListPageInput = {
  query: SessionListQuery
  /** The workspace a workspace-scoped query names, once resolved. */
  workspace: Workspace | undefined
  /** The local workspaces whose sessions a project-scoped query covers. */
  projectWorkspaces: () => Promise<Workspace[]>
  refreshSessionProjection?: (workspace: Workspace) => Promise<void>
  /** What a workspace's mounted runtime reports right now, read in process. */
  readRuntimeStatus: RuntimeStatusRead
  now?: () => number
}

/**
 * The signed caller's page: the authority's keyset read, authorized per row
 * in the query itself, for the project or the one workspace the query names.
 */
export async function signedSessionListPage(
  authority: WorkspaceAuthority,
  auth: SignedControlPlaneAuth,
  input: Pick<SessionListPageInput, "query" | "workspace">,
): Promise<SessionListResponse> {
  const { query } = input
  if (!authority.countSessions) throw new HTTPException(503, { message: "Session inventory counts are unavailable" })
  const scope = query.scope === "all" ? { all: true as const } : query.scope === "project" && query.projectId
    ? { projectId: query.projectId }
    : input.workspace
      ? { workspaceId: input.workspace.id }
      : undefined
  if (!scope) throw new HTTPException(400, { message: "Name a project or a workspace" })
  const sessions = await authority.listSessionPage(auth, { ...sessionListKeysetPage(query), ...scope })
  const response = buildSessionListResponse({
    query: "workspaceId" in scope ? { ...query, workspaceId: scope.workspaceId } : query,
    sessions,
    cursorApplied: true,
  })
  const totalKnown = await authority.countSessions(auth, { ...sessionListKeysetPage(query), ...scope })
  return { ...response, totalKnown }
}

/**
 * This machine's page, from its own projection. The projection of every
 * workspace the query covers is reconciled against its runtime first, once
 * per process, so a session the runtime holds is listed before it is next
 * written. Each row carries the status its runtime holds as the page is
 * read, so a reader needs no status read of its own; events move it on.
 */
export async function localSessionListPage(input: SessionListPageInput): Promise<SessionListResponse> {
  const { query } = input
  const population = query.scope === "all" || query.scope === "project" && query.projectId && !input.workspace
    ? await input.projectWorkspaces()
    : input.workspace ? [input.workspace] : []
  const covered = query.scope === "all" ? population.filter((workspace) => workspace.kind !== "cloud") : population
  await Promise.all(covered.map((workspace) => input.refreshSessionProjection?.(workspace)))
  const runtime = await readNavigationRuntimes(covered, input.readRuntimeStatus)
  const filter = { ...sessionListStorePageFilter(query),
    ...(query.scope === "all" ? { workspaceIDs: covered.map((workspace) => workspace.id) } : {}) }
  const metas = await listSessionNavigationMetas(filter)
  const response = buildSessionListResponse({
    query,
    sessions: await withNavigationContext(withRuntimeStatus(metas, runtime, (input.now ?? Date.now)()), covered),
    cursorApplied: true,
  })
  const totalKnown = countSessionNavigation(filter)
  return { ...response, totalKnown }
}

type NavigationRuntime = { activity?: Map<string, RuntimeSessionActivity>; executionAvailability: ExecutionAvailability }

async function readNavigationRuntimes(workspaces: readonly Workspace[], read: RuntimeStatusRead) {
  return new Map(await Promise.all(workspaces.map(async (workspace): Promise<readonly [string, NavigationRuntime]> => {
    try {
      const activity = await readRuntimeSessionActivity(read, workspace.id)
      return [workspace.id, { activity, executionAvailability: activity ? { status: "available" } : { status: "offline", message: "Session runtime is offline" } }]
    } catch (error) {
      return [workspace.id, { executionAvailability: { status: "unavailable", message: error instanceof Error ? error.message : "Session runtime is unavailable" } }]
    }
  })))
}

function withRuntimeStatus(metas: readonly SessionMeta[], runtime: ReadonlyMap<string, NavigationRuntime>, at: number) {
  return metas.map((meta) => {
    const entry = meta.workspaceID ? runtime.get(meta.workspaceID) : undefined
    const read = entry?.activity
    const session: RuntimeSessionActivity | undefined = read?.get(meta.sessionID)
    const executionAvailability = entry?.executionAvailability ?? { status: "unavailable" as const, message: "Session workspace is unavailable" }
    if (!read) return { ...meta, executionAvailability }
    const background = session?.backgroundWork ? { backgroundWork: session.backgroundWork } : {}
    return { ...meta, executionAvailability, status: { kind: session?.kind ?? "idle", awaitingInput: (session?.pending.size ?? 0) > 0, ...background, at } }
  })
}

async function withNavigationContext(metas: readonly SessionMeta[], workspaces: readonly Workspace[]) {
  const localMachineName = machineDisplayName(process.platform)
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
  const projects = new Map(await Promise.all([...new Set(metas.flatMap((meta) => meta.projectID ? [meta.projectID] : []))]
    .map(async (id) => [id, await getProjectRecord(id)] as const)))
  return metas.map((meta) => {
    const workspace = meta.workspaceID ? workspaceById.get(meta.workspaceID) : undefined
    const name = meta.projectID ? projects.get(meta.projectID)?.name : undefined
    return { ...meta, ownership: "owned", ...(name ? { projectName: name } : {}), ...(workspace ? { placement: workspace.kind === "cloud"
      ? { kind: "cloud", ...(workspace.workspace_name ? { cloudName: workspace.workspace_name } : {}) }
      : { kind: "local", machineName: localMachineName } } : {}) }
  })
}
