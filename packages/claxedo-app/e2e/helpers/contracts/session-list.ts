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
