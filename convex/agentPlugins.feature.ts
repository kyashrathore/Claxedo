/**
 * Build-selected root facade for the isolated Agent Plugins component.
 *
 * The default Convex application does not deploy this multi-dot source file.
 * The Agent Plugins deployment profile copies it to `agentPlugins.ts` and
 * mounts the component. Every exported function is service-token protected;
 * the control plane has already authenticated the bearer, but this facade
 * independently resolves the canonical user/org/project rows before passing
 * opaque internal IDs into the component.
 */
import { v } from "convex/values"
import { components } from "./_generated/api"
import {
  authorizeProjectForUser,
  authorizeWorkspaceForUser,
  orgAdminForUser,
  orgByClerkOrgId,
  orgMembership,
  projectByPublicId,
  serviceMutation,
  serviceQuery,
  userByTokenIdentifier,
  workspaceByPublicId,
} from "./model"

const pluginApi = (components as unknown as {
  agentPlugins: {
    activations: Record<string, unknown>
  }
}).agentPlugins.activations

const user = v.object({
  token_identifier: v.string(),
  subject: v.optional(v.string()),
  issuer: v.optional(v.string()),
})
const actorArgs = {
  user,
  clerk_org_id: v.optional(v.string()),
}
const harness = v.union(
  v.literal("opencode"),
  v.literal("claude"),
  v.literal("codex"),
  v.literal("cursor"),
)
const artifact = v.object({
  digest: v.string(),
  sourceId: v.string(),
  relativePath: v.string(),
  sourceRevision: v.string(),
})

function runComponentQuery(ctx: any, fn: unknown, args: Record<string, unknown>) {
  return (ctx.runQuery as unknown as (reference: unknown, input: Record<string, unknown>) => Promise<unknown>)(fn, args)
}

function runComponentMutation(ctx: any, fn: unknown, args: Record<string, unknown>) {
  return (ctx.runMutation as unknown as (reference: unknown, input: Record<string, unknown>) => Promise<unknown>)(fn, args)
}

async function actor(ctx: any, args: {
  user: { token_identifier: string }
  clerk_org_id?: string
}) {
  const canonicalUser = await userByTokenIdentifier(ctx.db, args.user.token_identifier)
  if (!canonicalUser) throw new Error("Agent Plugins user not found")
  const personalOrganizations = args.clerk_org_id ? [] : await ctx.db
        .query("orgs")
        .withIndex("by_owner", (q: any) => q.eq("owner_user_id", canonicalUser._id))
        .take(2)
  const personal = personalOrganizations.filter((item: any) => item.kind === "personal" && !item.clerk_org_id && !item.deleted_at)
  if (personal.length > 1) throw new Error("Agent Plugins personal organization is ambiguous")
  const organization = args.clerk_org_id
    ? await orgByClerkOrgId(ctx.db, args.clerk_org_id)
    : personal[0]
  if (!organization || organization.deleted_at) throw new Error("Agent Plugins organization not found")
  const membership = await orgMembership(ctx.db, organization._id, canonicalUser._id)
  if (!membership && organization.owner_user_id !== canonicalUser._id) {
    throw new Error("Agent Plugins organization membership is required")
  }
  return { user: canonicalUser, organization }
}

async function authorizedProject(ctx: any, input: {
  user: { _id: unknown }
  organization: { _id: unknown }
  projectId: string
  action: "read" | "write"
}) {
  const project = await projectByPublicId(ctx.db, input.projectId)
  if (!project || String(project.org_id) !== String(input.organization._id)) {
    throw new Error("Agent Plugins project access denied")
  }
  const role = await authorizeProjectForUser(ctx, project, input.user, input.action)
  if (!role) throw new Error("Agent Plugins project access denied")
  return project
}

function componentArgs(principal: Awaited<ReturnType<typeof actor>>) {
  return {
    organizationId: String(principal.organization._id),
    ownerUserId: String(principal.user._id),
  }
}

export const authorizeProject = serviceQuery({
  args: { ...actorArgs, project_id: v.string() },
  handler: async (ctx, args) => {
    const principal = await actor(ctx, args)
    await authorizedProject(ctx, { ...principal, projectId: args.project_id, action: "read" })
    return { allowed: true }
  },
})

export const revision = serviceQuery({
  args: actorArgs,
  handler: async (ctx, args) => {
    const principal = await actor(ctx, args)
    return await runComponentQuery(ctx, pluginApi.revision, {
      organizationId: String(principal.organization._id),
    })
  },
})

export const listKnown = serviceQuery({
  args: actorArgs,
  handler: async (ctx, args) => {
    const principal = await actor(ctx, args)
    return await runComponentQuery(ctx, pluginApi.listKnown, componentArgs(principal))
  },
})

export const read = serviceQuery({
  args: {
    ...actorArgs,
    project_id: v.optional(v.string()),
    plugin_instance_id: v.string(),
    harness_id: harness,
  },
  handler: async (ctx, args) => {
    const principal = await actor(ctx, args)
    if (args.project_id) {
      await authorizedProject(ctx, { ...principal, projectId: args.project_id, action: "read" })
    }
    return await runComponentQuery(ctx, pluginApi.read, {
      ...componentArgs(principal),
      projectId: args.project_id,
      pluginInstanceId: args.plugin_instance_id,
      harnessId: args.harness_id,
    })
  },
})

/**
 * Runtime read for an audience-bound Claxedo gateway token. The caller has no
 * Clerk bearer by design, so this independently rechecks the internal
 * user/org/project relationship before consulting the isolated component.
 */
export const runtimeRead = serviceQuery({
  args: {
    owner_user_id: v.string(),
    organization_id: v.string(),
    project_id: v.string(),
    workspace_id: v.string(),
    plugin_instance_id: v.string(),
    harness_id: harness,
  },
  handler: async (ctx, args) => {
    const userId = ctx.db.normalizeId("users", args.owner_user_id)
    const organizationId = ctx.db.normalizeId("orgs", args.organization_id)
    if (!userId || !organizationId) throw new Error("Agent Plugins runtime principal not found")
    const [canonicalUser, organization] = await Promise.all([
      ctx.db.get(userId),
      ctx.db.get(organizationId),
    ])
    if (!canonicalUser || !organization) throw new Error("Agent Plugins runtime principal not found")
    const membership = await orgMembership(ctx.db, organization._id, canonicalUser._id)
    if (!membership && String(organization.owner_user_id) !== String(canonicalUser._id)) {
      throw new Error("Agent Plugins organization membership is required")
    }
    await authorizedProject(ctx, {
      user: canonicalUser,
      organization,
      projectId: args.project_id,
      action: "read",
    })
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace
      || workspace.project_id !== args.project_id
      || String(workspace.org_id) !== String(organization._id)
      || !await authorizeWorkspaceForUser(ctx, workspace, canonicalUser, "read")) {
      throw new Error("Agent Plugins workspace access denied")
    }
    return await runComponentQuery(ctx, pluginApi.read, {
      organizationId: String(organization._id),
      ownerUserId: String(canonicalUser._id),
      projectId: args.project_id,
      pluginInstanceId: args.plugin_instance_id,
      harnessId: args.harness_id,
    })
  },
})

/** Whole desired runtime world, resolved from the workspace's canonical owner. */
export const runtimeSnapshot = serviceQuery({
  args: { workspace_id: v.string() },
  handler: async (ctx, args) => {
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace || workspace.backing !== "cloud-vm" || workspace.access !== "cloud") {
      throw new Error("Agent Plugins cloud workspace not found")
    }
    const [canonicalUser, organization, project] = await Promise.all([
      ctx.db.get(workspace.owner_user_id),
      ctx.db.get(workspace.org_id),
      projectByPublicId(ctx.db, workspace.project_id),
    ])
    if (!canonicalUser || !organization || !project
      || String(project.org_id) !== String(organization._id)
      || String(workspace.owner_user_id) !== String(canonicalUser._id)) {
      throw new Error("Agent Plugins runtime identity is inconsistent")
    }
    const membership = await orgMembership(ctx.db, organization._id, canonicalUser._id)
    if (!membership && String(organization.owner_user_id) !== String(canonicalUser._id)) {
      throw new Error("Agent Plugins organization membership is required")
    }
    const principal = { user: canonicalUser, organization }
    const known = await runComponentQuery(ctx, pluginApi.listKnown, componentArgs(principal)) as Array<{
      pluginInstanceId: string
      pins: Record<string, unknown>
    }>
    const plugins = await Promise.all(known.map(async (entry) => ({
      pluginInstanceId: entry.pluginInstanceId,
      pins: entry.pins,
      harnesses: Object.fromEntries(await Promise.all(["opencode", "claude", "codex", "cursor"].map(async (harnessId) => [
        harnessId,
        await runComponentQuery(ctx, pluginApi.read, {
          ...componentArgs(principal),
          projectId: workspace.project_id,
          pluginInstanceId: entry.pluginInstanceId,
          harnessId,
        }),
      ]))),
    })))
    return {
      revision: await runComponentQuery(ctx, pluginApi.revision, {
        organizationId: String(organization._id),
      }),
      identity: {
        userId: String(canonicalUser._id),
        organizationId: String(organization._id),
        projectId: workspace.project_id,
        workspaceId: args.workspace_id,
      },
      plugins,
    }
  },
})

export const mutateUser = serviceMutation({
  args: {
    ...actorArgs,
    plugin_instance_id: v.string(),
    harness_ids: v.array(harness),
    choice: v.optional(v.boolean()),
    target: v.union(
      v.object({ scope: v.literal("all-projects") }),
      v.object({ scope: v.literal("projects"), project_ids: v.array(v.string()) }),
    ),
    artifact: v.optional(artifact),
    expected_revision: v.number(),
    operation_id: v.string(),
  },
  handler: async (ctx, args) => {
    const principal = await actor(ctx, args)
    if (args.target.scope === "projects") {
      for (const projectId of [...new Set(args.target.project_ids)]) {
        await authorizedProject(ctx, { ...principal, projectId, action: "write" })
      }
    }
    return await runComponentMutation(ctx, pluginApi.mutateUser, {
      ...componentArgs(principal),
      pluginInstanceId: args.plugin_instance_id,
      harnessIds: args.harness_ids,
      choice: args.choice,
      target: args.target.scope === "all-projects"
        ? { scope: "all-projects" }
        : { scope: "projects", projectIds: args.target.project_ids },
      artifact: args.artifact,
      expectedRevision: args.expected_revision,
      operationId: args.operation_id,
    })
  },
})

export const mutateOrganizationDefault = serviceMutation({
  args: {
    ...actorArgs,
    plugin_instance_id: v.string(),
    harness_ids: v.array(harness),
    choice: v.optional(v.literal(true)),
    artifact: v.optional(artifact),
    expected_revision: v.number(),
    operation_id: v.string(),
  },
  handler: async (ctx, args) => {
    const principal = await actor(ctx, args)
    if (!await orgAdminForUser(ctx.db, principal.user._id, principal.organization._id)) {
      throw new Error("Agent Plugins organization admin access required")
    }
    return await runComponentMutation(ctx, pluginApi.mutateOrganizationDefault, {
      organizationId: String(principal.organization._id),
      pluginInstanceId: args.plugin_instance_id,
      harnessIds: args.harness_ids,
      choice: args.choice,
      artifact: args.artifact,
      expectedRevision: args.expected_revision,
      operationId: args.operation_id,
    })
  },
})

export const updatePin = serviceMutation({
  args: {
    ...actorArgs,
    authority: v.union(v.literal("user"), v.literal("organization")),
    plugin_instance_id: v.string(),
    artifact,
    expected_revision: v.number(),
    operation_id: v.string(),
  },
  handler: async (ctx, args) => {
    const principal = await actor(ctx, args)
    if (args.authority === "organization"
      && !await orgAdminForUser(ctx.db, principal.user._id, principal.organization._id)) {
      throw new Error("Agent Plugins organization admin access required")
    }
    return await runComponentMutation(ctx, pluginApi.updatePin, {
      ...componentArgs(principal),
      authority: args.authority,
      pluginInstanceId: args.plugin_instance_id,
      artifact: args.artifact,
      expectedRevision: args.expected_revision,
      operationId: args.operation_id,
    })
  },
})
