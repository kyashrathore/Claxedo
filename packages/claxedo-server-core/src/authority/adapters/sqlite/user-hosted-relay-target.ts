import type { UserHostedTargetResolver } from "../../../adapters/relay-port"
import { HOST_SERVING_WORKSPACE_SQL } from "./workspace-authority"
import { openAuthorityDb, type SqliteWorkspaceAuthorityOptions } from "./workspace-authority-store"

/**
 * Service-side relay lookup for SQLite-backed machine-placed workspaces, the
 * twin of the D1 adapter's `createD1UserHostedTargetResolver`.
 *
 * The internal resolver has machine authority, not an end-user principal, so
 * it cannot call `WorkspaceAuthority.activeWorkspaceHost`. It reads only the
 * routing fact — owner assignment AND the serving predicate every other
 * routability reader uses (`HOST_SERVING_WORKSPACE_SQL`) — and rechecks the
 * workspace's posture in the same query. Opens its own handle on the same
 * database file the authority uses (WAL, one process), the way every
 * beside-the-authority reader in this adapter does.
 */
export function createSqliteUserHostedTargetResolver(
  options: SqliteWorkspaceAuthorityOptions & { now?: () => number } = {},
): UserHostedTargetResolver & { close(): void } {
  const database = openAuthorityDb(options)
  const now = options.now ?? Date.now
  const resolve: UserHostedTargetResolver = async (workspaceId) => {
    if (!workspaceId.trim()) return { active: false }
    const row = database().prepare<unknown[], { host_id: string; backing: "local-worktree" | "cloud-vm" }>(`
      SELECT assignment.host_id, workspace.backing
      FROM host_workspace_assignments assignment
      JOIN host_enrollments enrollment ON enrollment.host_id = assignment.host_id
        AND enrollment.owner_token_identifier = assignment.owner_token_identifier
      JOIN workspaces workspace ON workspace.workspace_id = assignment.workspace_id
      WHERE assignment.workspace_id = ?
        AND ${HOST_SERVING_WORKSPACE_SQL}
        AND workspace.deleted_at IS NULL
        AND workspace.backing = 'local-worktree'
      LIMIT 1
    `).get(workspaceId, now())
    if (!row) return { active: false }
    return { active: true, hostId: row.host_id, backing: row.backing }
  }
  return Object.assign(resolve, { close: () => database.close() })
}
