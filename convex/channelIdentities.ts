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

function authResult(project: any, role: string | undefined) {
  if (!role) return { ok: false }
  return {
    ok: true,
    role,
    org_id: String(project.org_id),
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
    const result = authResult(project, await authorizeProjectForUser(ctx, project, user, args.action))
    return result.ok ? { ...result, actor_id: String(user._id), actor_kind: "human" as const } : result
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
    return { allowed: true, role, actor_id: String(user._id), actor_kind: "human" as const }
  },
})

export const bind = authedMutation({
  args: {
    channel: v.string(),
    external_user_id: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await upsertUser(ctx)
    const rows = await ctx.db
      .query("channel_identities")
      .withIndex("by_channel_external_user", (q: any) =>
        q.eq("channel", args.channel).eq("external_user_id", args.external_user_id))
      .collect()
    const active = rows.find((item: any) => !item.revoked_at)
    if (active) {
      if (active.user_id !== user._id) throw new Error("Channel identity is already bound")
      return {
        binding_id: String(active._id),
        created: false,
        user_id: String(user._id),
        actor_id: String(user._id),
        actor_kind: "human" as const,
      }
    }
    const now = Date.now()
    const bindingId = await ctx.db.insert("channel_identities", {
      channel: args.channel,
      external_user_id: args.external_user_id,
      user_id: user._id,
      created_at: now,
      updated_at: now,
    })
    return {
      binding_id: String(bindingId),
      created: true,
      user_id: String(user._id),
      actor_id: String(user._id),
      actor_kind: "human" as const,
    }
  },
})

export const revoke = authedMutation({
  args: {
    channel: v.string(),
    external_user_id: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await upsertUser(ctx)
    const rows = await ctx.db
      .query("channel_identities")
      .withIndex("by_channel_external_user", (q: any) =>
        q.eq("channel", args.channel).eq("external_user_id", args.external_user_id))
      .collect()
    const active = rows.find((item: any) => !item.revoked_at)
    if (!active) {
      const latest = rows.sort((left: any, right: any) => right._creationTime - left._creationTime)[0]
      return { revoked: latest?.user_id === user._id }
    }
    if (active.user_id !== user._id) return { revoked: false }
    await ctx.db.patch(active._id, { revoked_at: Date.now(), updated_at: Date.now() })
    return { revoked: true }
  },
})
