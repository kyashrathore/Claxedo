// Compatibility facade for hosted callers. The navigation contract is shared
// with the desktop-local product and therefore owned by server-core.
export * from "@claxedo/server-core/session/navigation-list"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import {
  buildSessionListResponse,
  type SessionListQuery,
  type SessionListResponse,
} from "@claxedo/server-core/session/navigation-list"
import { controlPlaneAuthErrorBody, ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority, type WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { ControlPlaneServices } from "../authority/services"
import { asRecord } from "@claxedo/server-core/platform/json/index"

/**
 * The refusal a session-list route gives when it is not the authority for the
 * workspace asked about. `ControlPlaneAuthError` cannot carry it: this is not
 * an authorization outcome — the caller may hold every right on the workspace —
 * it names a different server as the place to read.
 */
export class SessionListAuthorityError extends ClaxedoError {
  constructor(workspaceId: string) {
    super({
      code: "workspace_runtime_session_authority",
      message: `Sessions of workspace ${workspaceId} are listed by the machine that serves it`,
      status: 409,
    })
  }
}

/** Canonical flat inventory response for `GET /api/control/sessions`. */
export function sessionInventoryResponse(sessions: unknown) {
  return { sessions }
}

/**
 * The signed session-list read, as one implementation.
 *
 * `GET /api/control/session-list` is what the rail sidebar paginates and what
 * the signed desktop maps `session.navigationList` to. The hosted roots need
 * this read without pulling in the Node router — the workerd root cannot
 * mount `ControlPlaneSessionRoutes`, since that pulls the Node supervisor —
 * and duplicating sixty lines of project-resolution logic across three files
 * is how the next scope bug ships in one of them. So the read lives here, and
 * every route — canonical, hosted, hosted-core — asks it.
 *
 * Only the signed branch. The loopback/projection-store branch belongs to the
 * local product and stays with the canonical route.
 *
 * The registry is the authority for cloud sessions and for nothing else. The
 * sessions of a workspace placed on a machine live on that machine and are read
 * by the client over the relay in one hop, so this route names the runtime as
 * their authority rather than pulling them through here.
 */
export async function signedSessionList(
  services: ControlPlaneServices,
  auth: SignedControlPlaneAuth,
  query: SessionListQuery,
): Promise<SessionListResponse> {
  const directWorkspaceId = sessionListWorkspaceId(query)
  // A project-scoped list whose project id is not itself a workspace id:
  // resolve the project's workspaces here rather than rejecting. The sessions
  // stay project-scoped (they may span several workspaces), so the view keeps
  // `scope: "project"` and carries no single workspaceId.
  if (!directWorkspaceId && query.scope === "project" && query.projectId) {
    const workspaceIds = await registryWorkspaceIdsForProject(services, auth, query.projectId)
    if (workspaceIds.length === 0) return buildSessionListResponse({ query, sessions: [] })
    const authority = requireAuthority(services)
    const projectId = query.projectId
    const sessions = (await Promise.all(
      workspaceIds.map(async (workspaceId) => {
        const rows = await authority.listSessions(auth, { workspaceId })
        // The authority's per-workspace list carries neither the workspace id
        // it was asked for nor (always) a project id. Both are known here, and without them every row would fail
        // the project-scope filter (`rowInScope`) and build a workspace-less
        // sessionRef.
        return (Array.isArray(rows) ? rows : []).map((row) => ({
          ...(row && typeof row === "object" ? row : {}),
          workspace_id: workspaceId,
          project_id: projectId,
        }))
      }),
    )).flat()
    return buildSessionListResponse({ query, sessions })
  }
  const workspaceId = requiredWorkspaceId(directWorkspaceId)
  await assertRegistryIsSessionAuthority(services, auth, workspaceId)
  const sessions = await requireAuthority(services).listSessions(auth, { workspaceId })
  return buildSessionListResponse({
    query: {
      ...query,
      scope: query.scope === "global" || (query.scope === "project" && query.projectId === workspaceId)
        ? "workspace"
        : query.scope,
      workspaceId,
    },
    sessions: Array.isArray(sessions) ? sessions : [],
  })
}

/**
 * The runtime, not this registry, answers for a workspace placed on a machine.
 *
 * Refused rather than answered empty: an empty list is indistinguishable from
 * "this workspace holds no sessions", and a client reading it that way renders
 * an empty rail for a machine holding sixty of them.
 */
async function assertRegistryIsSessionAuthority(
  services: ControlPlaneServices,
  auth: SignedControlPlaneAuth,
  workspaceId: string,
) {
  const opened = await requireAuthority(services).openWorkspace(auth, { workspaceId })
  if (workspaceRow(workspaceRow(opened)?.workspace)?.backing !== "local-worktree") return
  throw new SessionListAuthorityError(workspaceId)
}

/**
 * The one answer every session-list route gives for a failed read.
 *
 * Three routes serve this list (canonical, hosted, hosted-core); consolidating
 * the auth and cursor mapping here keeps them from drifting apart, and a
 * route that cannot map the error re-throws it.
 */
export function sessionListErrorResponse(error: unknown): Response | undefined {
  if (error instanceof ControlPlaneAuthError) {
    return Response.json(controlPlaneAuthErrorBody(error), { status: error.status })
  }
  if (error instanceof SessionListAuthorityError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
  }
  if (error instanceof Error && error.message === "invalid_session_list_cursor") {
    return Response.json(
      { error: { code: "invalid_session_list_cursor", message: "Session list cursor does not match this query" } },
      { status: 400 },
    )
  }
  return undefined
}

export function requiredWorkspaceId(value: string | undefined) {
  if (value) return value
  throw new ControlPlaneAuthError(400, "workspace_id_required", "workspaceId is required")
}

function sessionListWorkspaceId(query: SessionListQuery) {
  return query.workspaceId ??
    (query.scope === "project" && query.projectId?.startsWith("ws_") ? query.projectId : undefined)
}

function workspaceRow(input: unknown) {
  return asRecord(input)
}

function rowText(input: unknown) {
  return typeof input === "string" && input.length > 0 ? input : undefined
}

/**
 * Every cloud workspace id belonging to a project.
 *
 * A project-scoped session list arrives with a project id, which only doubles
 * as a workspace id for the legacy `ws_`-prefixed shape. Resolving the
 * project's workspaces here — rather than requiring the caller to supply a
 * workspace id independently — serves callers like rail-sidebar.tsx's
 * ProjectBlock, which sends only `projectId`, without depending on inventory
 * shape drift in the browser.
 */
async function registryWorkspaceIdsForProject(
  services: { authority?: WorkspaceAuthority },
  auth: SignedControlPlaneAuth,
  projectId: string,
) {
  const workspaces = await requireAuthority(services).listWorkspaces(auth)
  if (!Array.isArray(workspaces)) return []
  return workspaces.flatMap((item) => {
    const row = workspaceRow(item)
    if (!row) return []
    const workspaceId = rowText(row.workspace_id) ?? rowText(row.workspaceId)
    if (!workspaceId) return []
    // A machine-placed workspace's sessions are the runtime's, not the
    // registry's: its rows here would be only those created through the control
    // plane, a subset of what its host holds. The client reads each one over
    // the relay.
    if (rowText(row.backing) === "local-worktree") return []
    const rowProjectId = rowText(row.project_id) ?? rowText(row.projectID) ?? rowText(row.projectId)
    return rowProjectId === projectId ? [workspaceId] : []
  })
}
