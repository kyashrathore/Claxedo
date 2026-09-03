import type { D1Database } from "@cloudflare/workers-types"

import type { UserHostedTargetResolver } from "../../sandbox-relay-target"

type ActiveHostRow = {
  host_id: string
  backing: "local-worktree" | "cloud-vm"
}

/**
 * Service-side relay lookup for D1-backed user-hosted workspaces.
 *
 * The internal resolver has machine authority, not an end-user principal, so
 * it cannot call `WorkspaceAuthority.activeWorkspaceHost`. It reads only the
 * minimum routing fact — owner assignment AND the machine's heartbeat-acked
 * served set AND a live enrollment lease — and rechecks authoritative
 * workspace posture in the same query.
 */
export function createD1UserHostedTargetResolver(
  database: D1Database,
  options: { now?: () => number; deploymentId?: string } = {},
): UserHostedTargetResolver {
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
        and enrollment.revoked_at is null
        and enrollment.paused_at is null
        and enrollment.expires_at > ?
        and exists (
          select 1 from json_each(coalesce(enrollment.acked_workspace_ids, '[]'))
          where json_each.value = assignment.workspace_id
        )
        and workspace.deleted_at is null
        and organization.deleted_at is null
        ${deploymentId ? "and organization.deployment_id = ?" : ""}
        and workspace.access = 'user-hosted'
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
