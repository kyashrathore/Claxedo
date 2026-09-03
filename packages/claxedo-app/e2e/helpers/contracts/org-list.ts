// CONTRACT BINDING: GET /api/control/orgs
//
// The organizations the signed principal belongs to. Read by `listOrgs`
// (src/features/settings/data/org-team-api.ts) for both the rail's
// org/team switcher (`rail-org-team-switcher.tsx`) and the Settings
// organization section (`org-team-section.tsx`), so opening the account menu
// or Settings at all issues this request.
//
// The real handler is `OrgTeamControlRoutes`' `GET /orgs`
// (packages/claxedo-server/src/session/routes/org-team-routes.ts), mounted
// under `/api/control` by every product deployment (asserted by
// `hosted-product-contract.test.ts` and `self-hosted-product-contract.test.ts`).
// It answers `authority.listOrgs(auth)` verbatim — a BARE JSON ARRAY, not an
// envelope. That shape is load-bearing: the switcher calls `.find` on the
// parsed body, so an object here renders the app's error boundary instead of
// the shell.
//
// The ROW TYPE is taken from a real producer rather than restated, so a field
// added, renamed, or dropped in the authority fails this package's typecheck on
// the same build. D1 is the adapter whose method carries an INFERRED return
// type (`WorkspaceAuthority` declares `listOrgs` as `Promise<unknown>`, so the
// port itself binds to nothing) — the same reason ./workspace-list.ts binds
// there.
//
// The zero state is `[]`, which is the authority's own honest answer for a
// principal that belongs to no organization (`organizationRows` returns its
// empty result set), not a stub standing in for an unimplemented route.
import type { D1WorkspaceAuthority } from "../../../../claxedo-server/src/authority/adapters/d1/workspace-authority"

/** One row of the org list, exactly as the authority projects it. */
export type ControlPlaneOrgRow = Awaited<ReturnType<D1WorkspaceAuthority["listOrgs"]>>[number]

/** `page.route` URL predicate for the BARE list (never `/orgs/:orgId/...`). */
export function isOrgListPath(pathname: string) {
  return pathname === "/api/control/orgs"
}

/** The list body: the authority's rows, unwrapped. */
export function orgListResponse(orgs: readonly ControlPlaneOrgRow[] = []): ControlPlaneOrgRow[] {
  return [...orgs]
}
