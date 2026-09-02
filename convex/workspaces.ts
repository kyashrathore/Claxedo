import { v } from "convex/values"
import { canonicalRepositoryKey, canonicalRepositoryUrl } from "@claxedo/server-core/authority/repository-key"
import {
  authedMutation,
  authedQuery,
  authorizeWorkspace,
  authorizeWorkspaceForUser,
  orgMembership,
  readUser,
  roleAllows,
  serviceUserByIdentity,
  serviceMutation,
  serviceQuery,
  upsertServiceUser,
  upsertUser,
  workspaceByPublicId,
  workspaceHostIsServing,
  workspaceRoleForUser,
} from "./model"
import { ensureDefaultTeamProjectGrant } from "./teams"

const workspaceId = { workspace_id: v.string() }
const serviceUser = v.object({
  token_identifier: v.string(),
  subject: v.optional(v.string()),
  issuer: v.optional(v.string()),
  email: v.optional(v.string()),
  name: v.optional(v.string()),
  image_url: v.optional(v.string()),
})
const localSharingArgs = {
  workspace_id: v.string(),
  org_id: v.optional(v.id("orgs")),
  display_name: v.string(),
  project_id: v.optional(v.string()),
  repo_url: v.optional(v.string()),
  repo_name: v.optional(v.string()),
  git_branch: v.optional(v.string()),
  remote_directory: v.optional(v.string()),
  home_region: v.optional(v.string()),
}

export const authorizeCreate = authedQuery({
  args: { org_id: v.optional(v.id("orgs")) },
  handler: async (ctx, args) => {
    if (!args.org_id) return { allowed: true }
    const user = await readUser(ctx)
    const org = await ctx.db.get(args.org_id)
    const membership = org ? await orgMembership(ctx.db, org._id, user._id) : undefined
    return {
      allowed: !!org && !org.deleted_at && (membership?.role === "owner" || membership?.role === "admin"),
    }
  },
})

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

export async function ensureOwnerOrg(ctx: any, user: { _id: unknown; name?: string; email?: string }) {
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

async function creationOrg(ctx: any, user: { _id: unknown; name?: string; email?: string }, orgId?: unknown) {
  if (!orgId) return ensureOwnerOrg(ctx, user)
  const org = await ctx.db.get(orgId)
  const membership = org ? await orgMembership(ctx.db, org._id, user._id) : undefined
  if (!org || org.deleted_at || !membership || membership.role === "member") {
    throw new Error("workspace_create_forbidden")
  }
  return org
}

export async function ensureProject(
  ctx: any,
  input: {
    projectId: string
    orgId: unknown
    ownerUserId: unknown
    repoKey?: string
  },
) {
  const requested = await ctx.db
    .query("projects")
    .withIndex("by_project_id", (q: any) => q.eq("project_id", input.projectId))
    .unique()
  if (requested && requested.org_id !== input.orgId) throw new Error("project_tenant_conflict")
  const repoKey = input.repoKey ?? requested?.repo_key ?? `workspace:${input.projectId}`
  const matching = await ctx.db
    .query("projects")
    .withIndex("by_org_repo_key", (q: any) => q.eq("org_id", input.orgId).eq("repo_key", repoKey))
    .unique()
  if (requested && matching && requested._id !== matching._id) throw new Error("project_repo_conflict")
  if (requested && requested.repo_key !== repoKey) {
    const requestedRepoKey = canonicalRepoKey({ repoKey: requested.repo_key, workspaceId: input.projectId })
    if (requestedRepoKey !== repoKey && !requested.repo_key.startsWith("workspace:")) {
      throw new Error("project_repo_conflict")
    }
    if (matching) throw new Error("project_repo_conflict")
    await ctx.db.patch(requested._id, { repo_key: repoKey, updated_at: Date.now() })
  }
  const existing = matching ?? requested
  const now = Date.now()
  const projectId =
    existing?._id ??
    (await ctx.db.insert("projects", {
      project_id: input.projectId,
      org_id: input.orgId,
      repo_key: repoKey,
      owner_user_id: input.ownerUserId,
      created_at: now,
      updated_at: now,
    }))
  const publicProjectId = existing?.project_id ?? input.projectId
  const membership = (
    await ctx.db
      .query("project_memberships")
      .withIndex("by_project_user", (q: any) => q.eq("project_id", publicProjectId))
      .collect()
  ).find((item: any) => item.user_id === input.ownerUserId)
  if (!membership) {
    await ctx.db.insert("project_memberships", {
      project_id: publicProjectId,
      user_id: input.ownerUserId,
      role: "owner",
      created_at: now,
      updated_at: now,
    })
  }
  await ensureDefaultTeamProjectGrant(ctx, {
    orgId: input.orgId,
    projectId: publicProjectId,
    creatorUserId: input.ownerUserId,
    now,
  })
  return await ctx.db.get(projectId)
}

export function defaultProjectId() {
  return `prj_${crypto.randomUUID()}`
}

export function canonicalRepoKey(input: {
  repoKey?: string
  repoUrl?: string
  remoteDirectory?: string
  workspaceId: string
}) {
  return canonicalRepositoryKey(input)
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

/**
 * Canonical repo identity for project matching. The two creation paths store
 * different strings for the SAME repository — connected repos persist GitHub's
 * clone_url (always `.git`-suffixed) while the paste-a-URL path stores whatever
 * was typed — so exact-string equality minted a duplicate project per URL
 * spelling (`https://github.com/o/r` vs `git@github.com:o/r.git`). Compare
 * canonical keys instead: protocol/credentials/port stripped, trailing slashes
 * and a `.git` suffix dropped, host lowercased (DNS is case-insensitive; the
 * path keeps its case — a false merge is worse than a missed one).
 */
const canonicalRepoUrl = canonicalRepositoryUrl

async function workGraphProject(
  ctx: any,
  input: {
    organizationId: unknown
    ownerUserId: unknown
    workspaceId: string
    repoUrl?: string
  },
) {
  const wanted = input.repoUrl ? canonicalRepoUrl(input.repoUrl) : undefined
  const matchingWorkspace = wanted
    ? (
        await ctx.db
          .query("workspaces")
          .withIndex("by_org", (query: any) => query.eq("org_id", input.organizationId))
          .collect()
      ).find(
        (workspace: any) =>
          !workspace.deleted_at &&
          workspace.project_id &&
          typeof workspace.repo_url === "string" &&
          canonicalRepoUrl(workspace.repo_url) === wanted,
      )
    : undefined
  return await ensureProject(ctx, {
    projectId: matchingWorkspace?.project_id ?? defaultProjectId(),
    orgId: input.organizationId,
    ownerUserId: input.ownerUserId,
    repoKey: canonicalRepoKey({ repoUrl: input.repoUrl, workspaceId: input.workspaceId }),
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

async function listWorkspacesForUser(ctx: any, user: { _id: unknown }) {
  const owned = await ctx.db
    .query("workspaces")
    .withIndex("by_owner", (q: any) => q.eq("owner_user_id", user._id))
    .collect()
  const memberships = await ctx.db
    .query("workspace_memberships")
    .withIndex("by_user", (q: any) => q.eq("user_id", user._id))
    .collect()
  const shares = await ctx.db
    .query("workspace_share_grants")
    .withIndex("by_user", (q: any) => q.eq("granted_to_user_id", user._id))
    .collect()
  const orgMemberships = await ctx.db
    .query("org_memberships")
    .withIndex("by_user", (q: any) => q.eq("user_id", user._id))
    .collect()

  const docs = new Map(owned.map((item: any) => [item._id, item]))
  for (const item of memberships) {
    const workspace = await ctx.db.get(item.workspace_id)
    if (workspace) docs.set(workspace._id, workspace)
  }
  for (const item of shares.filter((share: any) => !share.revoked_at)) {
    const workspace = await ctx.db.get(item.workspace_id)
    if (workspace) docs.set(workspace._id, workspace)
  }
  for (const item of orgMemberships) {
    const orgWorkspaces = await ctx.db
      .query("workspaces")
      .withIndex("by_org", (q: any) => q.eq("org_id", item.org_id))
      .collect()
    for (const workspace of orgWorkspaces) docs.set(workspace._id, workspace)
    const orgShares = await ctx.db
      .query("workspace_share_grants")
      .withIndex("by_org", (q: any) => q.eq("granted_to_org_id", item.org_id))
      .collect()
    for (const share of orgShares.filter((candidate: any) => !candidate.revoked_at)) {
      const workspace = await ctx.db.get(share.workspace_id)
      if (workspace) docs.set(workspace._id, workspace)
    }
  }

  return (
    await Promise.all(
      [...docs.values()]
        .filter((workspace: any) => !workspace.deleted_at)
        .map(async (workspace: any) => ({
          workspace_id: workspace.workspace_id,
          org_id: workspace.org_id,
          project_id: workspace.project_id,
          display_name: workspace.display_name,
          backing: workspace.backing,
          access: workspace.access,
          home_region: workspace.home_region,
          repo_url: workspace.repo_url,
          repo_name: workspace.repo_name,
          git_branch: workspace.git_branch,
          remote_directory: workspace.remote_directory,
          role: await workspaceRoleForUser(ctx, workspace, user),
          // Reachability, not authorization: a shared workspace whose machine
          // is asleep is still listed, and the rail says "host offline" for it
          // rather than dropping the row or waiting for a pane to discover it.
          ...(workspace.access === "user-hosted"
            ? { host_online: await workspaceHostIsServing(ctx, workspace.workspace_id) }
            : {}),
        })),
    )
  ).filter((item) => item.role && roleAllows(item.role, "read"))
}

export const list = authedQuery({
  args: {},
  handler: async (ctx) => listWorkspacesForUser(ctx, await readUser(ctx)),
})

export const listForService = serviceQuery({
  args: { user: serviceUser },
  handler: async (ctx, args) => {
    const user = await serviceUserByIdentity(ctx.db, args.user)
    return user ? listWorkspacesForUser(ctx, user) : []
  },
})

export const createCloud = authedMutation({
  args: {
    workspace_id: v.string(),
    org_id: v.optional(v.id("orgs")),
    project_id: v.optional(v.string()),
    display_name: v.string(),
    repo_url: v.optional(v.string()),
    repo_name: v.optional(v.string()),
    git_branch: v.optional(v.string()),
    home_region: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await upsertUser(ctx)
    // Pre-launch security review §4.1 — `workspace_id` is CALLER-supplied and
    // this is an `authedMutation`, so it is reachable directly through the
    // public Convex SDK using the deployment URL that ships in the app bundle
    // as `VITE_CONVEX_URL`. Hardening the Worker `POST /create` route does NOT
    // close this; the guard has to live here. Server-minted ids are
    // `ws_${Date.now().toString(36)}` — a bare millisecond timestamp with no
    // random component — so a victim's id is guessable within a plausible
    // creation window. Inserting a SECOND row carrying that public id bricks
    // the workspace for everyone: every lookup goes through
    // `workspaceByPublicId`, whose `.unique()` throws once two rows share an id.
    //
    // Same guard shape as `registerLocalForSharing` below, with create-specific
    // dispositions:
    // - Someone else's row (including a row the caller only holds an admin
    //   SHARE grant on) is opaque "Workspace not found". A create path must
    //   never write through a grant, and the message does not confirm the row's
    //   owner. Soft-deleted rows are treated the same way, so an id is never
    //   silently recycled.
    // - The caller's own USER-HOSTED workspace is a typed conflict rather than
    //   a silent backing flip — the mirror of `workspace_backing_conflict`.
    // - The caller's own cloud workspace returns the existing doc unchanged, so
    //   a create retry that reuses the id is a no-op instead of a hard failure.
    //   Nothing is patched, so this cannot be used to edit an existing row.
    const existing = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (existing) {
      if (existing.owner_user_id !== user._id || existing.deleted_at) throw new Error("Workspace not found")
      if (existing.backing !== "cloud-vm" || existing.access !== "cloud") {
        throw new Error("workspace_backing_conflict: cannot re-create a user-hosted workspace as a cloud workspace")
      }
      return { workspace_doc_id: existing._id }
    }
    const org = await creationOrg(ctx, user, args.org_id)
    const project = await ensureProject(ctx, {
      projectId: args.project_id ?? defaultProjectId(),
      orgId: org._id,
      ownerUserId: user._id,
      repoKey: canonicalRepoKey({ repoUrl: args.repo_url, workspaceId: args.workspace_id }),
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
          repoKey: canonicalRepoKey({ repoUrl: existing.repo_url, workspaceId: args.workspace_id }),
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

/** Shared with `hostEnrollments.assignWorkspace`, whose cold registration is exactly this. */
export async function registerLocalForSharingAs(ctx: any, args: any, user: { _id: unknown; name?: string; email?: string }) {
  const existing = await workspaceByPublicId(ctx.db, args.workspace_id)
  if (existing && !(await authorizeWorkspaceForUser(ctx, existing, user, "admin"))) {
    throw new Error("Workspace not found")
  }
  // This conflict is intrinsic to the workspace row and should remain
  // deterministic even if an older row is still awaiting tenant backfill.
  // No project or org lookup is needed to prove that a cloud workspace
  // cannot be converted into a user-hosted local workspace.
  if (existing && (existing.backing === "cloud-vm" || existing.access === "cloud")) {
    throw new Error("workspace_backing_conflict: cannot register a cloud workspace as a user-hosted local workspace")
  }
  const org = existing
    ? existing.org_id
      ? await ctx.db.get(existing.org_id)
      : undefined
    : await creationOrg(ctx, user, args.org_id)
  if (!org || org.deleted_at) throw new Error("workspace_tenant_missing")
  const project = await ensureProject(ctx, {
    projectId: existing?.project_id ?? args.project_id ?? defaultProjectId(),
    orgId: org._id,
    ownerUserId: user._id,
    repoKey: canonicalRepoKey({
      repoUrl: args.repo_url ?? existing?.repo_url,
      remoteDirectory: args.remote_directory ?? existing?.remote_directory,
      workspaceId: args.workspace_id,
    }),
  })
  const requestedHomeRegion = validatedHomeRegion(args.home_region)
  const now = Date.now()
  if (existing) {
    const home_region = existing.home_region ?? requestedHomeRegion
    await ctx.db.patch(existing._id, {
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
}

export const registerLocalForSharing = authedMutation({
  args: localSharingArgs,
  handler: async (ctx, args) => registerLocalForSharingAs(ctx, args, await upsertUser(ctx)),
})

export const registerLocalForSharingForService = serviceMutation({
  args: { user: serviceUser, ...localSharingArgs },
  handler: async (ctx, args) => registerLocalForSharingAs(ctx, args, await upsertServiceUser(ctx, args.user)),
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
