import { v } from "convex/values"
import { authedMutation, authorizeProject, projectByPublicId, upsertUser, userByClerkSubject, userByTokenIdentifier } from "./model"

const roleValue = v.union(v.literal("viewer"), v.literal("editor"), v.literal("admin"))

async function targetUser(ctx: any, args: {
  token_identifier?: string
  clerk_subject?: string
}) {
  if (args.token_identifier) return await userByTokenIdentifier(ctx.db, args.token_identifier)
  if (args.clerk_subject) return await userByClerkSubject(ctx.db, args.clerk_subject)
}

async function editableProject(ctx: any, projectId: string) {
  const project = await projectByPublicId(ctx.db, projectId)
  if (!project || !await authorizeProject(ctx, project, "admin")) throw new Error("Project not found")
  return project
}

async function existingMembership(ctx: any, projectId: unknown, userId: unknown) {
  return (await ctx.db
    .query("project_memberships")
    .withIndex("by_project_user", (q: any) => q.eq("project_id", projectId))
    .collect())
    .find((item: any) => item.user_id === userId)
}

const targetArgs = {
  project_id: v.string(),
  token_identifier: v.optional(v.string()),
  clerk_subject: v.optional(v.string()),
}

export const add = authedMutation({
  args: {
    ...targetArgs,
    role: roleValue,
  },
  handler: async (ctx, args) => {
    const project = await editableProject(ctx, args.project_id)
    const user = await targetUser(ctx, args)
    if (!user) throw new Error("User not found")
    const now = Date.now()
    const existing = await existingMembership(ctx, project._id, user._id)
    if (existing) {
      await ctx.db.patch(existing._id, { role: args.role, updated_at: now })
      return { membership_id: existing._id }
    }
    return {
      membership_id: await ctx.db.insert("project_memberships", {
        project_id: project._id,
        user_id: user._id,
        role: args.role,
        created_at: now,
        updated_at: now,
      }),
    }
  },
})

export const setRole = authedMutation({
  args: {
    ...targetArgs,
    role: roleValue,
  },
  handler: async (ctx, args) => {
    const project = await editableProject(ctx, args.project_id)
    const user = await targetUser(ctx, args)
    if (!user) throw new Error("User not found")
    const existing = await existingMembership(ctx, project._id, user._id)
    if (!existing) throw new Error("Membership not found")
    await ctx.db.patch(existing._id, { role: args.role, updated_at: Date.now() })
    return { membership_id: existing._id }
  },
})

export const remove = authedMutation({
  args: targetArgs,
  handler: async (ctx, args) => {
    const project = await editableProject(ctx, args.project_id)
    const actor = await upsertUser(ctx)
    const user = await targetUser(ctx, args)
    if (!user || user._id === actor._id) return { removed: false }
    const existing = await existingMembership(ctx, project._id, user._id)
    if (!existing || existing.role === "owner") return { removed: false }
    await ctx.db.delete(existing._id)
    return { removed: true }
  },
})
