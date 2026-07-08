import { mutationGeneric } from "convex/server"
import { v } from "convex/values"
import { upsertUser } from "./model"

export const record = mutationGeneric({
  args: {
    action: v.string(),
    result: v.union(v.literal("allow"), v.literal("deny")),
    reason: v.optional(v.string()),
    workspace_id: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const user = await upsertUser(ctx)
    const workspace = args.workspace_id
      ? await ctx.db
        .query("workspaces")
        .withIndex("by_workspace_id", (q) => q.eq("workspace_id", args.workspace_id))
        .unique()
      : undefined
    return await ctx.db.insert("audit_events", {
      user_id: user._id,
      workspace_id: workspace?._id,
      action: args.action,
      result: args.result,
      reason: args.reason,
      metadata: args.metadata,
      created_at: Date.now(),
    })
  },
})
