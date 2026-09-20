// CONTRACT BINDING: GET /api/workspace/resolve
//
// This binding calls the real server's response producer. It deliberately does
// not maintain a second field table in the e2e package: adding, removing, or
// renaming a field in the route projection changes the mock response on the same
// build.
import type { Workspace } from "../../../../claxedo-server-core/src/workspace/store/index"
import {
  workspaceResponse,
  type WorkspaceResponse,
} from "../../../../claxedo-server/src/workspace/workspace-response"
import { signedWorkspaceJson } from "../../../../claxedo-server/src/workspace/signed-access"
import type { ControlPlaneWorkspaceRow } from "./workspace-list"

export function workspaceResolveResponse(workspace: Workspace): WorkspaceResponse {
  const response = workspaceResponse(workspace)
  if (!response) throw new Error(`workspace resolve contract produced no response for ${workspace.id}`)
  return response
}

/**
 * Resolve as a SIGNED control plane answers it, from the same authority row the
 * list returns.
 *
 * A different producer from `workspaceResolveResponse` above, not a variant of
 * it: that one projects a row this server stores, while this one projects a row
 * the AUTHORITY holds for a workspace some other host serves. The two disagree
 * on `kind` for the same placement — the stored projection can only say `local`
 * or `cloud`, while this one says `user-hosted` for a `local-worktree` backing —
 * so a fixture that picked the wrong producer would hand the app a host kind the
 * real route never sends it.
 *
 * `signedWorkspaceJson` derives `kind` and the `backing` object from the row's
 * own `backing` string, so a fixture cannot put the two out of step.
 */
export function signedWorkspaceResolveResponse(row: ControlPlaneWorkspaceRow) {
  return signedWorkspaceJson({ workspace: row }, row.workspace_id)
}

/**
 * Workspace resolve has TWO spellings of one route: `workspaceResolveUrl`
 * (src/platform/runtime/agent/workspace-control-routes.ts) rewrites to
 * `/api/claxedo/workspace/resolve` on loopback transports — which every e2e
 * page is — while other transports keep `/api/workspace/resolve`. Fixtures
 * must serve both; use these instead of a single-spelling glob or `===`.
 */
export function isWorkspaceResolvePath(pathname: string) {
  return pathname === "/api/workspace/resolve" || pathname === "/api/claxedo/workspace/resolve"
}

/** `page.route` URL predicate covering both workspace-resolve spellings. */
export function workspaceResolveRoute(url: URL) {
  return isWorkspaceResolvePath(url.pathname)
}
