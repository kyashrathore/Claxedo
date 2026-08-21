// CONTRACT BINDING: GET /api/control/session-list
//
// Both the query normalization and the response projection come from the real
// server. An empty fixture is still meaningful evidence here: scope/group/sort/
// limit defaults are produced by `parseSessionListQuery`, not copied into the
// mock, and response shape comes from `buildSessionListResponse`.
import {
  buildSessionListResponse,
  parseSessionListQuery,
  type SessionListResponse,
} from "../../../../claxedo-server/src/session/list"

export function emptySessionNavigationListResponse(url: string): SessionListResponse {
  const query = parseSessionListQuery(new URL(url))
  return buildSessionListResponse({ query, sessions: [] })
}

/**
 * The session navigation list has TWO spellings of one route:
 * `sessionNavigationListUrl` (src/platform/runtime/agent/workspace-control-routes.ts)
 * rewrites to `/api/claxedo/session-list` on loopback transports — which every
 * e2e page is — while other transports keep `/api/control/session-list`.
 * Fixtures must serve both; use this predicate with `page.route` (or on a
 * pathname inside a broader handler) instead of a single-spelling glob.
 */
export function isSessionListPath(pathname: string) {
  return pathname === "/api/control/session-list" || pathname === "/api/claxedo/session-list"
}

/** `page.route` URL predicate covering both session-list spellings. */
export function sessionListRoute(url: URL) {
  return isSessionListPath(url.pathname)
}

/**
 * The FLAT session inventory read by `fetchLocalControlSessions`
 * (src/features/session/data/sync/inventory-source.ts) also has two spellings:
 * the local control plane serves `GET /api/claxedo/session`
 * (claxedo-local-server/src/session/routes/meta-routes.ts) while signed-cloud
 * contexts keep `GET /api/control/sessions`
 * (`controlSessionListUrl`, src/platform/runtime/agent/workspace-control-routes.ts).
 * Exact-match on purpose: a `**?/api/claxedo/session**` glob would also swallow
 * `/api/claxedo/session-list` above.
 */
export function isSessionInventoryPath(pathname: string) {
  return pathname === "/api/claxedo/session" || pathname === "/api/control/sessions"
}

/** `page.route` URL predicate covering both session-inventory spellings. */
export function sessionInventoryRoute(url: URL) {
  return isSessionInventoryPath(url.pathname)
}
