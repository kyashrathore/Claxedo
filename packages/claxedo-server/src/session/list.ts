// Compatibility facade for hosted callers. The navigation contract is shared
// with the desktop-local product and therefore owned by server-core.
export * from "@claxedo/server-core/session/navigation-list"
import {
  buildSessionListResponse,
  sessionListKeysetPage,
  type SessionListQuery,
  type SessionListResponse,
} from "@claxedo/server-core/session/navigation-list"
import { controlPlaneAuthErrorBody, ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import { sessionPageScope, type PrivateSessionAuthority } from "@claxedo/server-core/platform/auth/private-session-authority"
import type { ControlPlaneServices } from "../authority/services"

type SessionListRequestErrorCode = "session_list_scope_required"

export class SessionListRequestError extends ClaxedoError<SessionListRequestErrorCode> {
  constructor(code: SessionListRequestErrorCode, message: string) {
    super({ code, message, status: 400 })
  }
}

/** Canonical flat inventory response for `GET /api/control/sessions`. */
export function sessionInventoryResponse(sessions: unknown) {
  return { sessions }
}

/**
 * The signed session-list read, as one implementation.
 *
 * `GET /api/control/session-list` pages a project's sessions, one
 * workspace's, or every session the caller may read (`scope=all`: the
 * workspaces it owns and the sessions shared to it), across every workspace
 * the registry holds rows for: cloud
 * workspaces, whose sessions it registers, and workspaces placed on machines,
 * whose sessions those machines publish. The hosted roots need this read
 * without the Node router (the workerd root cannot mount
 * `ControlPlaneSessionRoutes`), so every route asks it.
 *
 * Each page is one keyset read of the registry, filtered by the caller's
 * session access in the same query.
 */
export async function signedSessionList(
  services: ControlPlaneServices,
  auth: SignedControlPlaneAuth,
  query: SessionListQuery,
): Promise<SessionListResponse> {
  const scope = sessionPageScope(query)
  if (!scope) throw new SessionListRequestError("session_list_scope_required", "Name a project, a workspace or every session")
  const sessions = await requireAuthority(services).listSessionPage(auth, { ...sessionListKeysetPage(query), ...scope })
  return buildSessionListResponse({ query, sessions, cursorApplied: true })
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
  if (error instanceof SessionListRequestError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: 400 })
  }
  if (error instanceof ClaxedoError && error.code === "invalid_session_list_cursor") {
    return Response.json(
      { error: { code: "invalid_session_list_cursor", message: "Session list cursor does not match this query" } },
      { status: 400 },
    )
  }
  return undefined
}

/**
 * One workspace's sessions as its owner lists them, for a caller the plane
 * verified as that owner without a signed request of its own: a session
 * host's first-party MCP bearer. The same registry page the signed list
 * reads, so a session served by its own Durable Object is listed beside the
 * ones the workspace's machine holds.
 */
export async function ownerSessionList(
  authority: Pick<PrivateSessionAuthority, "listOwnerSessionPage">,
  owner: { userId: string; actorId: string },
  workspaceId: string,
  limit: number,
): Promise<SessionListResponse["items"]> {
  const query: SessionListQuery = { scope: "workspace", workspaceId, archived: "active", settled: "all", status: [], sort: "updated_desc", limit }
  const sessions = await authority.listOwnerSessionPage(owner, { ...sessionListKeysetPage(query), workspaceId })
  return buildSessionListResponse({ query, sessions, cursorApplied: true }).items
}
