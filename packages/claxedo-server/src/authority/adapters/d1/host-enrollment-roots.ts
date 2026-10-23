import type { D1Database } from "@cloudflare/workers-types"
import { hostPathWithinRoots } from "@claxedo/account-contract/host-path"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { hostEnrollmentScope } from "@claxedo/server-core/platform/auth/host-connect-contract"
import { requireHuman } from "./access-context"
import { activeGuard, batchUnder } from "./authorization"
import { D1HostAccessAuthorityError } from "./host-access-errors"
import { enrollmentOf, requireText } from "./host-enrollment-records"
import { requireScope } from "./host-scope-rules"

/**
 * Owner only: `folder` joins the roots of their approved machine unless a root
 * already covers it, or the machine was enrolled from an account and has no
 * roots to widen. Adding never narrows, so no assignment is retired; the write
 * is guarded on the scope revision it read, and the machine takes the new roots
 * from its next beat.
 */
export async function addD1HostEnrollmentRoot(
  database: D1Database,
  deploymentId: string,
  auth: SignedControlPlaneAuth,
  args: { hostId: string; folder: string },
  now: number,
): Promise<{ changed: boolean; scope_revision: number }> {
  const who = await requireHuman(database, deploymentId, auth)
  const row = await enrollmentOf(database, who.actorId, requireText(args.hostId, "hostId"))
  if (!row || row.revoked_at !== null || row.approval_requested_at !== null) {
    throw new D1HostAccessAuthorityError("host_enrollment_not_found", "Host enrollment not found")
  }
  const scope = hostEnrollmentScope(row.scope_json, row.scope_revision)
  if (!scope || hostPathWithinRoots(args.folder, scope.allowed_roots)) return { changed: false, scope_revision: row.scope_revision }
  const roots = requireScope({ allowed_roots: [...scope.allowed_roots, requireText(args.folder, "folder", 1_024)] })
  const [result] = await batchUnder(database, activeGuard(who), [database.prepare(`
    update host_enrollments set scope_json = ?, scope_revision = scope_revision + 1, updated_at = ?
    where enrollment_id = ? and owner_actor_id = ? and scope_revision = ? and revoked_at is null
  `).bind(JSON.stringify(roots), now, row.enrollment_id, who.actorId, row.scope_revision)])
  if ((result?.meta?.changes ?? 0) !== 1) {
    throw new D1HostAccessAuthorityError("resource_conflict", "The machine's roots changed while this folder was being added")
  }
  return { changed: true, scope_revision: row.scope_revision + 1 }
}
