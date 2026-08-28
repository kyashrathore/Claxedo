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
 * it cannot call `WorkspaceAuthority.activeLocalHostLink`. It reads only the
 * minimum routing fact and rechecks both the host-link lease and authoritative
 * workspace posture in one query.
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
      select link.host_id, workspace.backing
      from local_host_links as link
      inner join workspaces as workspace on workspace.workspace_id = link.workspace_id
      inner join orgs as organization on organization.org_id = workspace.org_id
      where link.workspace_id = ?
        and link.revoked_at is null
        and link.paused_at is null
        and link.expires_at > ?
        and workspace.deleted_at is null
        and organization.deleted_at is null
        ${deploymentId ? "and organization.deployment_id = ?" : ""}
        and workspace.access = 'user-hosted'
        and workspace.backing = 'local-worktree'
      order by link.last_seen_at desc, link.host_id
      limit 1
    `,
      )
      .bind(workspaceId, now(), ...(deploymentId ? [deploymentId] : []))
      .first<ActiveHostRow>()
    if (!row) return { active: false }
    return { active: true, hostId: row.host_id, backing: row.backing }
  }
}
