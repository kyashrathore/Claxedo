// CONTRACT BINDING: GET /api/workspace?access=<cloud|user-hosted>
//
// The control plane's workspace list — the ONLY source the sidebar catalog has
// for relay-backed workspaces once the hosted boot aggregate
// (`GET /api/claxedo/bootstrap`) stopped carrying them. `workspaceCatalogQuery`
// (src/features/workspaces/data/workspace-catalog.ts) asks for BOTH access
// kinds concurrently and folds the two answers into one catalog.
//
// Two real handlers serve this route and they are deliberately identical in
// shape (the hosted one says so in its own comment):
//   - packages/claxedo-server/src/workspace/routes/index.ts        GET "/"
//   - packages/claxedo-server/src/routes/hosted/workspace.ts       GET "/"
// Both answer `{ workspaces: [...] }` from `authority.listWorkspaces(auth)` and
// filter to `access === "user-hosted"` rows ONLY for `?access=user-hosted`;
// `?access=cloud` is NOT a filter — it is "list what this principal can reach",
// so it returns every visible row of both kinds. `mergeWorkspaceCatalog` keys
// rows by directory, so the overlap between the two calls collapses instead of
// double-listing.
//
// The ROW TYPE is taken from a real producer rather than restated here, so a
// field added, renamed, or dropped in the authority fails this package's
// typecheck on the same build. All three authority adapters project the same
// row (verified):
//   - packages/claxedo-server/src/authority/adapters/d1/workspace-authority.ts
//   - packages/claxedo-server-core/src/authority/adapters/sqlite/workspace-authority.ts
// D1 is the one whose method carries an INFERRED return type (`WorkspaceAuthority`
// declares `listWorkspaces` as `Promise<unknown>`, so going through the port or
// through the sqlite factory's explicit annotation would bind to nothing).
//
// NOT on the row, deliberately: `status`. `workspace-catalog.ts` reads it if
// present, but no authority emits it on a LIST row — only the resolve
// projection (`workspace-response.ts`, see ./workspace-resolve.ts) carries a
// workspace status. A mock that invented one here would be asserting against a
// field the real list can never return.
import type { D1WorkspaceAuthority } from "../../../../claxedo-server/src/authority/adapters/d1/workspace-authority"

/** One row of `{ workspaces }`, exactly as the authority projects it. */
export type ControlPlaneWorkspaceRow = Awaited<ReturnType<D1WorkspaceAuthority["listWorkspaces"]>>[number]

/** `?access` values the route treats as a signed control-plane list. */
export type WorkspaceListAccess = ControlPlaneWorkspaceRow["access"]

/** `page.route` URL predicate for the BARE list (never `/resolve`, `/create`, `/:id/...`). */
export function isWorkspaceListPath(pathname: string) {
  return pathname === "/api/workspace" || pathname === "/api/workspace/"
}

/**
 * The list body for one `?access` query.
 *
 * Mirrors both route handlers: `user-hosted` filters, every other value
 * (including `cloud`) returns the caller's whole visible inventory.
 */
export function workspaceListResponse(input: {
  access: string | null
  workspaces: readonly ControlPlaneWorkspaceRow[]
}): { workspaces: ControlPlaneWorkspaceRow[] } {
  return {
    workspaces: input.access === "user-hosted"
      ? input.workspaces.filter((row) => row.access === "user-hosted")
      : [...input.workspaces],
  }
}
