import { queryGeneric } from "convex/server"
import { v } from "convex/values"
import {
  authorizeProjectForUser,
  authorizeWorkspaceForUser,
  projectByPublicId,
  workspaceByPublicId,
} from "./model"

const action = v.union(v.literal("read"), v.literal("write"), v.literal("admin"), v.literal("owner"))
const channelIdentityArgs = {
  service_token: v.string(),
  channel: v.string(),
  external_user_id: v.string(),
  thread_key: v.string(),
}

function serviceToken() {
  const value = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN?.trim()
  return value ? value : undefined
}

function requireService(input: string) {
  const expected = serviceToken()
  if (!expected || input !== expected) throw new Error("Unauthenticated")
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

export const authorizeProject = queryGeneric({
  args: {
    ...channelIdentityArgs,
    project_id: v.string(),
    action,
  },
  handler: async (ctx, args) => {
    requireService(args.service_token)
    const user = await linkedUser(ctx, args)
    if (!user) return { ok: false }
    const project = await projectByPublicId(ctx.db, args.project_id)
    if (!project) return { ok: false }
    return authResult(project, await authorizeProjectForUser(ctx, project, user, args.action))
  },
})

export const authorizeWorkspace = queryGeneric({
  args: {
    ...channelIdentityArgs,
    workspace_id: v.string(),
    action,
  },
  handler: async (ctx, args) => {
    requireService(args.service_token)
    const user = await linkedUser(ctx, args)
    if (!user) return { allowed: false }
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace) return { allowed: false }
    const role = await authorizeWorkspaceForUser(ctx, workspace, user, args.action)
    if (!role) return { allowed: false }
    return { allowed: true, role }
  },
})
