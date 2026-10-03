import { sessionHostRootOf } from "@claxedo/workspace-relay-protocol"
import type { RelayBacking } from "./auth"
import { errorBody } from "./http"
import { workspaceRelayForwardRequestInit, workspaceRelayTargetUrl, type AuthorizedWorkspaceRelayRequest } from "./server"

/** The `SESSION_HOST` binding: one Durable Object per top-level session, named by that session's id. */
export type SessionHostNamespace = {
  getByName: (name: string) => { fetch: (input: string, init?: RequestInit) => Promise<Response> }
}

/**
 * A Durable Object stub ignores the origin of the URL it is fetched with; the
 * path and query are what reach the session host.
 */
const SESSION_HOST_ORIGIN = "https://session-host.invalid"

function unavailable() {
  return Response.json(errorBody("session_host_unavailable", "The session host is unavailable"), { status: 503 })
}

export function isSessionHostTarget(target: { backing: RelayBacking }): boolean {
  return target.backing === "durable-object"
}

export function isSessionHostNamespace(value: unknown): value is SessionHostNamespace {
  return !!value && typeof value === "object" && "getByName" in value && typeof value.getByName === "function"
}

/**
 * Forwards one HTTP request to the session's Durable Object with the Relay
 * Host Token the authorization minted. The browser's cookies never reach it,
 * as they never reach a host tunnel, and the response body streams through
 * untouched so a session's event stream stays open.
 */
export async function forwardSessionHostHttp(
  namespace: SessionHostNamespace | undefined,
  request: Request,
  authorized: AuthorizedWorkspaceRelayRequest,
): Promise<Response> {
  const root = sessionHostRootOf(authorized.target.hostId)
  if (!namespace || !root) return unavailable()
  const url = workspaceRelayTargetUrl({ ...authorized.target, baseUrl: SESSION_HOST_ORIGIN }, authorized.path, new URL(request.url).search)
  const init = workspaceRelayForwardRequestInit(request, authorized.relayHostToken, authorized.target.workspaceId, { hostTunnel: true })
  let upstream: Response
  try {
    upstream = await namespace.getByName(root).fetch(url.toString(), init)
  } catch {
    return unavailable()
  }
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers })
}
