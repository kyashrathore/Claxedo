import { v } from "convex/values"
import {
  authedMutation,
  authedQuery,
  authorizeWorkspace,
  readUser,
  roleAllows,
  serviceMutation,
  upsertUser,
  workspaceByPublicId,
  workspaceRole,
} from "./model"

const workspaceId = { workspace_id: v.string() }

// Mirrors `CLAXEDO_REGIONS` in packages/claxedo-server/src/region. Convex only
// VALIDATES supplied regions; it never defaults one — normalization to the
// configured default region happens server-side at read time.
const KNOWN_HOME_REGIONS = ["apac-south", "apac-east", "eu-west", "us-east", "us-west"]

function validatedHomeRegion(input?: string) {
  if (input === undefined) return undefined
  if (!KNOWN_HOME_REGIONS.includes(input)) {
    throw new Error(`home_region_invalid: ${input} is not a known Claxedo region`)
  }
  return input
}

async function ensureOwnerOrg(ctx: any, user: { _id: unknown; name?: string; email?: string }) {
  const existing = (
    await ctx.db
      .query("orgs")
      .withIndex("by_owner", (q: any) => q.eq("owner_user_id", user._id))
      .collect()
  ).find((org: any) => org.kind === "personal" && !org.clerk_org_id && !org.deleted_at)
  if (existing) return existing
  const now = Date.now()
  const orgId = await ctx.db.insert("orgs", {
    name: user.name ?? user.email ?? "Personal",
    kind: "personal",
    owner_user_id: user._id,
    created_at: now,
    updated_at: now,
  })
  await ctx.db.insert("org_memberships", {
    org_id: orgId,
    user_id: user._id,
    role: "owner",
    created_at: now,
    updated_at: now,
  })
  return await ctx.db.get(orgId)
}

async function ensureProject(
  ctx: any,
  input: {
    projectId: string
    orgId: unknown
    ownerUserId: unknown
  },
) {
  const existing = await ctx.db
    .query("projects")
    .withIndex("by_project_id", (q: any) => q.eq("project_id", input.projectId))
    .unique()
  const now = Date.now()
  const projectId =
    existing?._id ??
    (await ctx.db.insert("projects", {
      project_id: input.projectId,
      org_id: input.orgId,
      owner_user_id: input.ownerUserId,
      created_at: now,
      updated_at: now,
    }))
  const membership = (
    await ctx.db
      .query("project_memberships")
      .withIndex("by_project_user", (q: any) => q.eq("project_id", projectId))
      .collect()
  ).find((item: any) => item.user_id === input.ownerUserId)
  if (!membership) {
    await ctx.db.insert("project_memberships", {
      project_id: projectId,
      user_id: input.ownerUserId,
      role: "owner",
      created_at: now,
      updated_at: now,
    })
  }
  return await ctx.db.get(projectId)
}

function defaultProjectId(workspaceId: string) {
  return `prj_${workspaceId}`
}

async function requireWorkGraphOwner(ctx: any, input: { organizationId: unknown; ownerUserId: unknown }) {
  const [organization, owner] = await Promise.all([ctx.db.get(input.organizationId), ctx.db.get(input.ownerUserId)])
  if (!organization || organization.deleted_at || !owner) throw new Error("WorkGraph workspace owner not found")
  const membership = await ctx.db
    .query("org_memberships")
    .withIndex("by_org_user", (query: any) => query.eq("org_id", input.organizationId).eq("user_id", input.ownerUserId))
    .unique()
  if (organization.owner_user_id !== input.ownerUserId && !membership) {
    throw new Error("WorkGraph workspace owner is not a member of the organization")
  }
  return owner
}

async function ensureWorkspaceMembership(ctx: any, workspaceId: unknown, ownerUserId: unknown, now: number) {
  const membership = await ctx.db
    .query("workspace_memberships")
    .withIndex("by_workspace_user", (query: any) => query.eq("workspace_id", workspaceId).eq("user_id", ownerUserId))
    .unique()
  if (membership) return
  await ctx.db.insert("workspace_memberships", {
    workspace_id: workspaceId,
    user_id: ownerUserId,
    role: "owner",
    created_at: now,
    updated_at: now,
  })
}

async function workGraphProject(
  ctx: any,
  input: {
    organizationId: unknown
    ownerUserId: unknown
    workspaceId: string
    repoUrl?: string
  },
) {
  const matchingWorkspace = input.repoUrl
    ? (
        await ctx.db
          .query("workspaces")
          .withIndex("by_org", (query: any) => query.eq("org_id", input.organizationId))
          .collect()
      ).find((workspace: any) => !workspace.deleted_at && workspace.repo_url === input.repoUrl && workspace.project_id)
    : undefined
  return await ensureProject(ctx, {
    projectId: matchingWorkspace?.project_id ?? defaultProjectId(input.workspaceId),
    orgId: input.organizationId,
    ownerUserId: input.ownerUserId,
  })
}

export const open = authedQuery({
  args: workspaceId,
  handler: async (ctx, args) => {
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace) return { allowed: false }
    const role = await authorizeWorkspace(ctx, workspace, "read")
    if (!role) return { allowed: false }
    return {
      allowed: true,
      role,
      workspace: {
        workspace_id: workspace.workspace_id,
        org_id: workspace.org_id,
        project_id: workspace.project_id,
        backing: workspace.backing,
        access: workspace.access,
        home_region: workspace.home_region,
        display_name: workspace.display_name,
        repo_url: workspace.repo_url,
        repo_name: workspace.repo_name,
        git_branch: workspace.git_branch,
      },
    }
  },
})

export const list = authedQuery({
  args: {},
  handler: async (ctx) => {
    const user = await readUser(ctx)
    const owned = await ctx.db
      .query("workspaces")
      .withIndex("by_owner", (q) => q.eq("owner_user_id", user._id))
      .collect()
    const memberships = await ctx.db
      .query("workspace_memberships")
      .withIndex("by_user", (q) => q.eq("user_id", user._id))
      .collect()
    const shares = await ctx.db
      .query("workspace_share_grants")
      .withIndex("by_user", (q) => q.eq("granted_to_user_id", user._id))
      .collect()
    const orgMemberships = await ctx.db
      .query("org_memberships")
      .withIndex("by_user", (q) => q.eq("user_id", user._id))
      .collect()

    const docs = new Map(owned.map((item) => [item._id, item]))
    for (const item of memberships) {
      const workspace = await ctx.db.get(item.workspace_id)
      if (workspace) docs.set(workspace._id, workspace)
    }
    for (const item of shares.filter((share) => !share.revoked_at)) {
      const workspace = await ctx.db.get(item.workspace_id)
      if (workspace) docs.set(workspace._id, workspace)
    }
    for (const item of orgMemberships) {
      const orgWorkspaces = await ctx.db
        .query("workspaces")
        .withIndex("by_org", (q) => q.eq("org_id", item.org_id))
        .collect()
      for (const workspace of orgWorkspaces) {
        docs.set(workspace._id, workspace)
      }
      const orgShares = await ctx.db
        .query("workspace_share_grants")
        .withIndex("by_org", (q) => q.eq("granted_to_org_id", item.org_id))
        .collect()
      for (const share of orgShares.filter((share) => !share.revoked_at)) {
        const workspace = await ctx.db.get(share.workspace_id)
        if (workspace) docs.set(workspace._id, workspace)
      }
    }

    return (
      await Promise.all(
        [...docs.values()]
          .filter((workspace) => !workspace.deleted_at)
          .map(async (workspace) => ({
            workspace_id: workspace.workspace_id,
            display_name: workspace.display_name,
            backing: workspace.backing,
            access: workspace.access,
            remote_directory: workspace.remote_directory,
            role: await workspaceRole(ctx, workspace),
          })),
      )
    ).filter((item) => item.role && roleAllows(item.role, "read"))
  },
})

export const createCloud = authedMutation({
  args: {
    workspace_id: v.string(),
    project_id: v.optional(v.string()),
    display_name: v.string(),
    repo_url: v.optional(v.string()),
    repo_name: v.optional(v.string()),
    git_branch: v.optional(v.string()),
    home_region: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await upsertUser(ctx)
    const org = await ensureOwnerOrg(ctx, user)
    const project = await ensureProject(ctx, {
      projectId: args.project_id ?? defaultProjectId(args.workspace_id),
      orgId: org._id,
      ownerUserId: user._id,
    })
    const home_region = validatedHomeRegion(args.home_region)
    const now = Date.now()
    const id = await ctx.db.insert("workspaces", {
      workspace_id: args.workspace_id,
      org_id: org._id,
      owner_user_id: user._id,
      project_id: project.project_id,
      backing: "cloud-vm",
      access: "cloud",
      ...(home_region ? { home_region } : {}),
      display_name: args.display_name,
      repo_url: args.repo_url,
      repo_name: args.repo_name,
      git_branch: args.git_branch,
      created_at: now,
      updated_at: now,
    })
    await ctx.db.insert("workspace_memberships", {
      workspace_id: id,
      user_id: user._id,
      role: "owner",
      created_at: now,
      updated_at: now,
    })
    return { workspace_doc_id: id }
  },
})

export const ensureWorkGraph = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    workspace_id: v.string(),
    display_name: v.optional(v.string()),
    repo_url: v.optional(v.string()),
    repo_name: v.optional(v.string()),
    git_branch: v.optional(v.string()),
    home_region: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireWorkGraphOwner(ctx, {
      organizationId: args.organization_id,
      ownerUserId: args.owner_user_id,
    })
    const homeRegion = validatedHomeRegion(args.home_region)
    const now = Date.now()
    const existing = await workspaceByPublicId(ctx.db, args.workspace_id)
    const project = existing?.project_id
      ? await ensureProject(ctx, {
          projectId: existing.project_id,
          orgId: args.organization_id,
          ownerUserId: args.owner_user_id,
        })
      : await workGraphProject(ctx, {
          organizationId: args.organization_id,
          ownerUserId: args.owner_user_id,
          workspaceId: args.workspace_id,
          ...(args.repo_url ? { repoUrl: args.repo_url } : {}),
        })
    if (existing) {
      if (
        existing.owner_user_id !== args.owner_user_id ||
        existing.org_id !== args.organization_id ||
        existing.backing !== "cloud-vm" ||
        existing.access !== "cloud"
      ) {
        throw new Error("WorkGraph workspace identity conflicts with an existing workspace")
      }
      await ctx.db.patch(existing._id, {
        project_id: project.project_id,
        ...(args.display_name ? { display_name: args.display_name } : {}),
        ...(homeRegion ? { home_region: homeRegion } : {}),
        ...(args.repo_url !== undefined ? { repo_url: args.repo_url } : {}),
        ...(args.repo_name !== undefined ? { repo_name: args.repo_name } : {}),
        ...(args.git_branch !== undefined ? { git_branch: args.git_branch } : {}),
        deleted_at: undefined,
        updated_at: now,
      })
      await ensureWorkspaceMembership(ctx, existing._id, args.owner_user_id, now)
      return { workspace_id: args.workspace_id, project_id: project.project_id }
    }
    const id = await ctx.db.insert("workspaces", {
      workspace_id: args.workspace_id,
      org_id: args.organization_id,
      owner_user_id: args.owner_user_id,
      project_id: project.project_id,
      backing: "cloud-vm",
      access: "cloud",
      ...(homeRegion ? { home_region: homeRegion } : {}),
      display_name: args.display_name ?? "WorkGraph Session",
      repo_url: args.repo_url,
      repo_name: args.repo_name,
      git_branch: args.git_branch,
      created_at: now,
      updated_at: now,
    })
    await ensureWorkspaceMembership(ctx, id, args.owner_user_id, now)
    return { workspace_id: args.workspace_id, project_id: project.project_id }
  },
})

export const registerLocalForSharing = authedMutation({
  args: {
    workspace_id: v.string(),
    display_name: v.string(),
    project_id: v.optional(v.string()),
    repo_url: v.optional(v.string()),
    repo_name: v.optional(v.string()),
    git_branch: v.optional(v.string()),
    remote_directory: v.optional(v.string()),
    home_region: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await upsertUser(ctx)
    const org = await ensureOwnerOrg(ctx, user)
    const project = await ensureProject(ctx, {
      projectId: args.project_id ?? defaultProjectId(args.workspace_id),
      orgId: org._id,
      ownerUserId: user._id,
    })
    const requestedHomeRegion = validatedHomeRegion(args.home_region)
    const now = Date.now()
    const existing = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (existing) {
      if (!(await authorizeWorkspace(ctx, existing, "admin"))) throw new Error("Workspace not found")
      // Never silently flip a cloud workspace's backing: registering it as a
      // user-hosted local workspace is a conflict, not an update.
      if (existing.backing === "cloud-vm" || existing.access === "cloud") {
        throw new Error(
          "workspace_backing_conflict: cannot register a cloud workspace as a user-hosted local workspace",
        )
      }
      const home_region = existing.home_region ?? requestedHomeRegion
      await ctx.db.patch(existing._id, {
        org_id: org._id,
        owner_user_id: user._id,
        backing: "local-worktree",
        access: "user-hosted",
        ...(home_region ? { home_region } : {}),
        display_name: args.display_name,
        // Patch only supplied fields — re-registration must not erase
        // previously recorded metadata with `undefined`.
        project_id: project.project_id,
        ...(args.repo_url !== undefined ? { repo_url: args.repo_url } : {}),
        ...(args.repo_name !== undefined ? { repo_name: args.repo_name } : {}),
        ...(args.git_branch !== undefined ? { git_branch: args.git_branch } : {}),
        ...(args.remote_directory !== undefined ? { remote_directory: args.remote_directory } : {}),
        updated_at: now,
      })
      return { workspace_doc_id: existing._id, workspace_id: args.workspace_id, home_region }
    }

    const home_region = requestedHomeRegion
    const id = await ctx.db.insert("workspaces", {
      workspace_id: args.workspace_id,
      org_id: org._id,
      owner_user_id: user._id,
      project_id: project.project_id,
      backing: "local-worktree",
      access: "user-hosted",
      ...(home_region ? { home_region } : {}),
      display_name: args.display_name,
      repo_url: args.repo_url,
      repo_name: args.repo_name,
      git_branch: args.git_branch,
      remote_directory: args.remote_directory,
      created_at: now,
      updated_at: now,
    })
    await ctx.db.insert("workspace_memberships", {
      workspace_id: id,
      user_id: user._id,
      role: "owner",
      created_at: now,
      updated_at: now,
    })
    return { workspace_doc_id: id, workspace_id: args.workspace_id, home_region }
  },
})

export const remove = authedMutation({
  args: workspaceId,
  handler: async (ctx, args) => {
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace || !(await authorizeWorkspace(ctx, workspace, "owner"))) throw new Error("Workspace not found")
    await ctx.db.patch(workspace._id, {
      deleted_at: Date.now(),
      updated_at: Date.now(),
    })
    return { deleted: true }
  },
})

export { remove as delete }
