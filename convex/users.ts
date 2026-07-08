import { mutationGeneric } from "convex/server"
import { upsertUser } from "./model"
import { personalOrgForUser } from "./orgs"

export const me = mutationGeneric({
  args: {},
  handler: async (ctx) => {
    const user = await upsertUser(ctx)
    const org = await personalOrgForUser(ctx, user)
    return {
      user_id: user._id,
      subject: user.clerk_subject,
      token_identifier: user.token_identifier,
      org_id: org?._id,
    }
  },
})
