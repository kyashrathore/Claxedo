import { authorizeWorkspaceForUser, orgAdminForUser } from "./model"

async function sessionShareAllowsUser(ctx: any, input: { user: { _id: unknown }; sessionId: string }) {
  const [grants, orgMemberships, teamMemberships] = await Promise.all([
    ctx.db
      .query("session_share_grants")
      .withIndex("by_session", (q: any) => q.eq("session_id", input.sessionId))
      .collect(),
    ctx.db
      .query("org_memberships")
      .withIndex("by_user", (q: any) => q.eq("user_id", input.user._id))
      .collect(),
    ctx.db
      .query("team_memberships")
      .withIndex("by_user", (q: any) => q.eq("user_id", input.user._id))
      .collect(),
  ])
  const orgIds = new Set(orgMemberships.map((membership: any) => membership.org_id))
  const teamIds = new Set(teamMemberships.map((membership: any) => membership.team_id))
  return grants.some((grant: any) =>
    !grant.revoked_at
    && (
      grant.granted_to_user_id === input.user._id
      || (grant.granted_to_org_id && orgIds.has(grant.granted_to_org_id))
      || (grant.granted_to_team_id && teamIds.has(grant.granted_to_team_id))
    ))
}

/** Canonical per-session role resolver shared by session I/O and People policy. */
export async function sessionRoleForWorkspaceUser(
  ctx: any,
  input: {
    user: { _id: unknown }
    workspace: Record<string, any>
    session: Record<string, any>
    workspaceRole: unknown
    isOrgAdmin?: boolean
  },
) {
  if (input.session.workspace_id !== input.workspace._id) return
  if (input.session.created_by_user_id === input.user._id) return input.workspaceRole
  const participant = await ctx.db
    .query("session_participants")
    .withIndex("by_session_user", (q: any) =>
      q.eq("session_id", input.session.session_id).eq("user_id", input.user._id),
    )
    .unique()
  if (participant && !participant.revoked_at) return input.workspaceRole
  if (await sessionShareAllowsUser(ctx, { user: input.user, sessionId: input.session.session_id })) {
    return input.workspaceRole
  }
  const isOrgAdmin = input.isOrgAdmin ?? await orgAdminForUser(ctx.db, input.user._id, input.workspace.org_id)
  if (isOrgAdmin) return input.workspaceRole
}

export async function sessionRoleForUser(
  ctx: any,
  input: {
    user: { _id: unknown }
    workspace: Record<string, any>
    session: Record<string, any>
    action: "read" | "write"
  },
) {
  const workspaceRole = await authorizeWorkspaceForUser(ctx, input.workspace, input.user, input.action)
  if (!workspaceRole) return
  return await sessionRoleForWorkspaceUser(ctx, { ...input, workspaceRole })
}
