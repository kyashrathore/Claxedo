import { queryGeneric } from "convex/server"
import { v } from "convex/values"
import { authorizeProject, projectByPublicId, projectRole } from "./model"

const projectArgs = {
  project_id: v.string(),
  org_id: v.optional(v.string()),
}

function authResult(project: any, role: string | undefined, requestedOrgId?: string) {
  if (!role) return { ok: false }
  if (requestedOrgId && requestedOrgId !== String(project.org_id)) return { ok: false }
  return {
    ok: true,
    role,
    org_id: String(project.org_id),
  }
}

export const role = queryGeneric({
  args: projectArgs,
  handler: async (ctx, args) => {
    const project = await projectByPublicId(ctx.db, args.project_id)
    if (!project) return { ok: false }
    return authResult(project, await projectRole(ctx, project), args.org_id)
  },
})

export const authorize = queryGeneric({
  args: {
    ...projectArgs,
    action: v.union(v.literal("read"), v.literal("write"), v.literal("admin"), v.literal("owner")),
  },
  handler: async (ctx, args) => {
    const project = await projectByPublicId(ctx.db, args.project_id)
    if (!project) return { ok: false }
    return authResult(project, await authorizeProject(ctx, project, args.action), args.org_id)
  },
})
