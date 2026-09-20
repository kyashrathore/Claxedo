import type { D1Database } from "@cloudflare/workers-types"

import type { HostTunnelTargetResolver } from "../../sandbox-relay-target"
import { HOST_SERVING_WORKSPACE_SQL } from "./host-access-authority"

type ActiveHostRow = {
  host_id: string
  backing: "local-worktree" | "cloud-vm"
}

/**
 * Service-side relay lookup for a workspace placed on an enrolled machine.
 *
 * The internal resolver has machine authority, not an end-user principal, so
 * it cannot call `WorkspaceAuthority.activeWorkspaceHost`. It reads the
 * placement — the owner's assignment naming the machine — under the serving
 * predicate every other routability reader uses (`HOST_SERVING_WORKSPACE_SQL`),
 * and rechecks the workspace's posture in the same query. A provisioner-owned
 * workspace is refused by its backing: no enrollment serves a cloud VM.
 */
export function createD1HostTunnelTargetResolver(
  database: D1Database,
  options: { now?: () => number; deploymentId?: string } = {},
): HostTunnelTargetResolver {
  const now = options.now ?? Date.now
  const deploymentId = options.deploymentId?.trim()
  return async (workspaceId) => {
    if (!workspaceId.trim()) return { active: false }
    const row = await database
      .prepare(
        `
      select assignment.host_id, workspace.backing
      from host_workspace_assignments as assignment
      inner join host_enrollments as enrollment
        on enrollment.host_id = assignment.host_id
        and enrollment.owner_actor_id = assignment.owner_actor_id
      inner join workspaces as workspace on workspace.workspace_id = assignment.workspace_id
      inner join orgs as organization on organization.org_id = workspace.org_id
      where assignment.workspace_id = ?
        and ${HOST_SERVING_WORKSPACE_SQL}
        and workspace.deleted_at is null
        and organization.deleted_at is null
        ${deploymentId ? "and organization.deployment_id = ?" : ""}
        and workspace.backing = 'local-worktree'
      limit 1
    `,
      )
      .bind(workspaceId, now(), ...(deploymentId ? [deploymentId] : []))
      .first<ActiveHostRow>()
    if (!row) return { active: false }
    return { active: true, hostId: row.host_id, backing: row.backing }
  }
}
