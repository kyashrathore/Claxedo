// Compatibility facade for hosted callers. The navigation contract is shared
// with the desktop-local product and therefore owned by server-core.
export * from "@claxedo/server-core/session/navigation-list"
import {
  buildSessionListResponse,
  type SessionListQuery,
  type SessionListResponse,
} from "@claxedo/server-core/session/navigation-list"
import { controlPlaneAuthErrorBody, ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority, type WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { ControlPlaneServices } from "../authority/services"
import { HostedSessionPullError, pullHostedControlSessionList } from "../authority/hosted-session-pull"
import { WorkspaceRuntimeTargetError } from "../authority/runtime-target"

/** Canonical flat inventory response for `GET /api/control/sessions`. */
export function sessionInventoryResponse(sessions: unknown) {
  return { sessions }
}

/**
 * The signed session-list read, as ONE implementation.
 *
 * `GET /api/control/session-list` is what the rail sidebar paginates and what
 * the signed desktop maps `session.navigationList` to. It used to exist only on
 * `ControlPlaneSessionRoutes`, which the Node roots mount and the workerd root
 * cannot (it pulls the Node supervisor). Moving hosted onto workerd therefore
 * dropped the route: the hosted app answered its most-used read with Hono's
 * bare 404 — invisible server-side, and the browser never got as far as
 * reporting it because a preflight failed first. The signed desktop hit the
 * same hole with no browser involved.
 *
 * The hosted roots need the read without the Node router, and duplicating
 * sixty lines of project-resolution logic across three files is how the next
 * scope bug ships in one of them. So the read lives here, and every route —
 * canonical, hosted, hosted-core — asks it.
 *
 * Only the SIGNED branch. The loopback/projection-store branch belongs to the
 * local product and stays with the canonical route.
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
    const workspaceIds = await projectWorkspaceIds(services, auth, query.projectId)
    if (workspaceIds.length === 0) return buildSessionListResponse({ query, sessions: [] })
    const authority = requireAuthority(services)
    const projectId = query.projectId
    const sessions = (await Promise.all(
      workspaceIds.map(async (workspaceId) => {
        // A user-hosted workspace's sessions live on its host, not here. One
        // host being offline must not blank the whole project's list — the
        // workspace page reports that on its own — so an offline host
        // contributes nothing rather than an error.
        const hosted = await hostedSessions(services, auth, workspaceId).catch(() => undefined)
        const rows = hosted ?? await authority.listSessions(auth, { workspaceId })
        // The authority's per-workspace list carries neither the workspace id
        // it was asked for nor (always) a project id — see convex/sessions.ts
        // `list`. Both are known here, and without them every row would fail
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
  // Direct workspace scope: an offline host is the answer, not an empty list.
  const sessions = await hostedSessions(services, auth, workspaceId)
    ?? await requireAuthority(services).listSessions(auth, { workspaceId })
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
 * The host's sessions for a user-hosted workspace, or undefined for any other
 * kind. Pull failures (host offline, relay unreachable, denied) propagate as
 * the pull layer's own errors; `sessionListErrorResponse` answers them.
 */
function hostedSessions(services: ControlPlaneServices, auth: SignedControlPlaneAuth, workspaceId: string) {
  return pullHostedControlSessionList(services, auth, { workspaceId })
}

/**
 * The one answer every session-list route gives for a failed read.
 *
 * Three routes serve this list (canonical, hosted, hosted-core). Each used to
 * carry its own copy of the auth and cursor mapping; now that the read can
 * also fail at the host — 409 host offline, 503 relay unavailable — the
 * mapping lives once, and a route that cannot map the error re-throws it.
 */
export function sessionListErrorResponse(error: unknown): Response | undefined {
  if (error instanceof ControlPlaneAuthError) {
    return Response.json(controlPlaneAuthErrorBody(error), { status: error.status })
  }
  if (error instanceof Error && error.message === "invalid_session_list_cursor") {
    return Response.json(
      { error: { code: "invalid_session_list_cursor", message: "Session list cursor does not match this query" } },
      { status: 400 },
    )
  }
  if (error instanceof HostedSessionPullError || error instanceof WorkspaceRuntimeTargetError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
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
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined
}

function rowText(input: unknown) {
  return typeof input === "string" && input.length > 0 ? input : undefined
}

/**
 * Every workspace id belonging to a project.
 *
 * A project-scoped session list arrives with a PROJECT id, which only doubles
 * as a workspace id for the legacy `ws_`-prefixed shape. Anything else used to
 * 400 (`workspace_id_required`), which made the whole sidebar section fail
 * whenever the client could not independently supply the workspace id — see
 * rail-sidebar.tsx's ProjectBlock, which sends `projectId` and never a
 * `workspaceId`. Resolving it here means every client benefits and the list no
 * longer depends on inventory shape drift in the browser.
 */
async function projectWorkspaceIds(
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
    const rowProjectId = rowText(row.project_id) ?? rowText(row.projectID) ?? rowText(row.projectId)
    return rowProjectId === projectId ? [workspaceId] : []
  })
}
