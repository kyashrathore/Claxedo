import type { D1Database } from "@cloudflare/workers-types"
import { AGENT_PLUGIN_ALL_PROJECTS_SCOPE, AGENT_PLUGIN_DESKTOP_WORKSPACE } from "@claxedo/server-core/agent-plugins/activation/runtime-scope"
import type { SessionCleanupScope } from "../../../session/cleanup-capability"
import { orgMemberSql } from "./authorization"

export type SessionCleanupMachine = NonNullable<SessionCleanupScope["host"]>
export type MachineCleanupOwner = Pick<SessionCleanupScope, "userId" | "actorId" | "orgId"> & {
  projectId: typeof AGENT_PLUGIN_ALL_PROJECTS_SCOPE
}

type MachineOwnerRow = { user_id: string; actor_id: string; org_id: string }

export async function resolveDesktopCleanupOwner(
  database: D1Database,
  identity: Pick<SessionCleanupScope, "userId" | "actorId" | "orgId">,
): Promise<MachineCleanupOwner | undefined> {
  if (!identity.userId || !identity.actorId || !identity.orgId) return undefined
  const owner = await database.prepare(`
    SELECT owner.user_id, owner_actor.actor_id, org.org_id
    FROM users owner
    JOIN actors owner_actor ON owner_actor.user_id = owner.user_id
      AND owner_actor.kind = 'human' AND owner_actor.state = 'active'
    JOIN orgs org ON org.org_id = ? AND ${orgMemberSql("org.org_id", "owner.user_id")}
    WHERE owner.user_id = ? AND owner.state = 'active' AND owner_actor.actor_id = ?
  `).bind(identity.orgId, identity.userId, identity.actorId).first<MachineOwnerRow>()
  return owner ? cleanupOwner(owner) : undefined
}

export async function resolveMachineCleanupOwner(
  database: D1Database,
  host: SessionCleanupMachine,
  ownerUserId: string,
  orgId?: string,
  options: { now?: () => number } = {},
): Promise<MachineCleanupOwner | undefined> {
  if (!host.hostId || !host.enrollmentId || !ownerUserId || (orgId !== undefined && !orgId)
    || !Number.isSafeInteger(host.generation) || host.generation < 0) return undefined
  const values = [host.hostId, host.enrollmentId, host.generation, ownerUserId, (options.now ?? Date.now)()]
  if (orgId !== undefined) values.push(orgId)
  const { results } = await database.prepare(`
    SELECT owner.user_id, owner_actor.actor_id, org.org_id
    FROM host_enrollments enrollment
    JOIN users owner ON owner.user_id = enrollment.owner_user_id AND owner.state = 'active'
    JOIN actors owner_actor ON owner_actor.actor_id = enrollment.owner_actor_id
      AND owner_actor.user_id = owner.user_id AND owner_actor.kind = 'human' AND owner_actor.state = 'active'
    JOIN orgs org ON ${orgMemberSql("org.org_id", "owner.user_id")}
    WHERE enrollment.host_id = ? AND enrollment.enrollment_id = ? AND enrollment.serving_generation = ?
      AND enrollment.owner_user_id = ? AND enrollment.revoked_at IS NULL AND enrollment.paused_at IS NULL
      AND enrollment.expires_at > ? ${orgId === undefined ? "" : "AND org.org_id = ?"}
    LIMIT 2
  `).bind(...values).all<MachineOwnerRow>()
  if (results.length !== 1) return undefined
  return cleanupOwner(results[0])
}

function cleanupOwner(owner: MachineOwnerRow): MachineCleanupOwner {
  return { userId: owner.user_id, actorId: owner.actor_id, orgId: owner.org_id, projectId: AGENT_PLUGIN_ALL_PROJECTS_SCOPE }
}

export function machineSessionCleanupScope(owner: MachineCleanupOwner, host: SessionCleanupMachine): SessionCleanupScope {
  return {
    userId: owner.userId,
    actorId: owner.actorId,
    orgId: owner.orgId,
    projectId: AGENT_PLUGIN_ALL_PROJECTS_SCOPE,
    workspaceId: AGENT_PLUGIN_DESKTOP_WORKSPACE,
    host: { hostId: host.hostId, enrollmentId: host.enrollmentId, generation: host.generation },
  }
}
