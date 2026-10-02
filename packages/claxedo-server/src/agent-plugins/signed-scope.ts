import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { asRecord, stringField } from "@claxedo/server-core/platform/json/index"
import { mayGuard, type BoundSql } from "../authority/adapters/d1/authorization"

/**
 * The signed caller the Agent Plugins stores act for: the canonical user and
 * actor every rule is asked about, and the organization they act in. It is
 * also an `AuthorizationPrincipal`, so no rule sees a user without its actor.
 */
export type AgentPluginScope = { userId: string; actorId: string; orgId: string }

export type AgentPluginScopeAuthority = Pick<WorkspaceAuthority, "usersMe" | "resolveOrgId">

export async function resolveAgentPluginScope(
  authority: AgentPluginScopeAuthority,
  auth: SignedControlPlaneAuth,
): Promise<AgentPluginScope> {
  const me = asRecord(await authority.usersMe(auth))
  const userId = stringField(me, "user_id")
  const actorId = stringField(me, "actor_id")
  if (!userId || !actorId) throw new Error("The authority returned no canonical Agent Plugins principal")
  const orgId = stringField(me, "org_id") || (await authority.resolveOrgId(auth))
  return { userId, actorId, orgId }
}

/**
 * Every rule an Agent Plugins write was admitted under, for its batch to ask
 * again: the organization action its authority needs, and `write` on each
 * project it changes.
 */
export function agentPluginWriteGuard(
  scope: AgentPluginScope,
  authority: "user" | "organization",
  projectIds: readonly string[] = [],
): BoundSql {
  const guards = [
    mayGuard(scope, authority === "organization" ? "administer" : "member", { kind: "org", orgId: scope.orgId }),
    ...projectIds.map((projectId) => mayGuard(scope, "write", { kind: "project", projectId, orgId: scope.orgId })),
  ]
  return { sql: guards.map((guard) => guard.sql).join(" and "), bind: guards.flatMap((guard) => guard.bind) }
}
