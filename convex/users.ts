import { v } from "convex/values"
import { authedMutation, serviceMutation, serviceQuery, upsertServiceUser, upsertUser, userByClerkSubject } from "./model"
import { personalOrgForUser } from "./orgs"

export const me = authedMutation({
  args: {},
  handler: async (ctx) => {
    const user = await upsertUser(ctx)
    const org = await personalOrgForUser(ctx, user)
    return {
      user_id: user._id,
      actor_id: user._id,
      actor_kind: user.kind ?? "human",
      actor_public_id: user.public_id,
      actor_name: user.name ?? user.email ?? (user.kind === "agent" ? "Agent" : "User"),
      actor_avatar_url: user.image_url,
      subject: user.clerk_subject,
      token_identifier: user.token_identifier,
      org_id: org?._id,
    }
  },
})

export const meForService = serviceMutation({
  args: {
    user: v.object({
      token_identifier: v.string(),
      subject: v.optional(v.string()),
      issuer: v.optional(v.string()),
      email: v.optional(v.string()),
      name: v.optional(v.string()),
      image_url: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const user = await upsertServiceUser(ctx, args.user)
    const org = await personalOrgForUser(ctx, user)
    return {
      user_id: user._id,
      actor_id: user._id,
      actor_kind: user.kind,
      actor_public_id: user.public_id,
      actor_name: user.name ?? "Agent",
      actor_avatar_url: user.image_url,
      subject: user.clerk_subject,
      token_identifier: user.token_identifier,
      org_id: org?._id,
    }
  },
})

export const resolveSubjectForService = serviceQuery({
  args: {
    subject: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await userByClerkSubject(ctx.db, args.subject)
    if (!user) return null
    return {
      actor_id: user._id,
      actor_kind: user.kind,
    }
  },
})
