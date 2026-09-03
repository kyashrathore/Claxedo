import { v } from "convex/values"
import {
  authedMutation,
  authorizeProjectForUser,
  authorizeWorkspaceForUser,
  projectByPublicId,
  serviceQuery,
  upsertUser,
  workspaceByPublicId,
} from "./model"

const action = v.union(v.literal("read"), v.literal("write"), v.literal("admin"), v.literal("owner"))
const channelIdentityArgs = {
  channel: v.string(),
  external_user_id: v.string(),
  thread_key: v.string(),
}

async function linkedUser(ctx: { db: any }, args: { channel: string; external_user_id: string }) {
  const links = await ctx.db
    .query("channel_identities")
    .withIndex("by_channel_external_user", (q: any) =>
      q.eq("channel", args.channel).eq("external_user_id", args.external_user_id))
    .collect()
  const link = links.find((item: any) => !item.revoked_at)
  return link ? await ctx.db.get(link.user_id) : undefined
}

function authResult(project: any, user: any, role: string | undefined) {
  if (!role) return { ok: false }
  return {
    ok: true,
    role,
    org_id: String(project.org_id),
    actor_id: String(user._id),
    actor_kind: user.kind ?? "human",
    ...(user.public_id
      ? {
          actor_public_id: user.public_id,
          actor_name: user.name ?? user.email ?? (user.kind === "agent" ? "Agent" : "User"),
          ...(user.image_url ? { actor_avatar_url: user.image_url } : {}),
        }
      : {}),
  }
}

export const authorizeProject = serviceQuery({
  args: {
    ...channelIdentityArgs,
    project_id: v.string(),
    action,
  },
  handler: async (ctx, args) => {
    const user = await linkedUser(ctx, args)
    if (!user) return { ok: false }
    const project = await projectByPublicId(ctx.db, args.project_id)
    if (!project) return { ok: false }
    return authResult(project, user, await authorizeProjectForUser(ctx, project, user, args.action))
  },
})

export const authorizeWorkspace = serviceQuery({
  args: {
    ...channelIdentityArgs,
    workspace_id: v.string(),
    action,
  },
  handler: async (ctx, args) => {
    const user = await linkedUser(ctx, args)
    if (!user) return { allowed: false }
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace) return { allowed: false }
    const role = await authorizeWorkspaceForUser(ctx, workspace, user, args.action)
    if (!role) return { allowed: false }
    return {
      allowed: true,
      role,
      actor_id: String(user._id),
      actor_kind: user.kind ?? "human",
      ...(user.public_id
        ? {
            actor_public_id: user.public_id,
            actor_name: user.name ?? user.email ?? (user.kind === "agent" ? "Agent" : "User"),
            ...(user.image_url ? { actor_avatar_url: user.image_url } : {}),
          }
        : {}),
    }
  },
})
