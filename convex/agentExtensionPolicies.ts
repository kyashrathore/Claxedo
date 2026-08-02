import type { GenericDatabaseReader, GenericDatabaseWriter } from "convex/server"
import { v, type GenericId } from "convex/values"
import {
  authedMutation,
  authedQuery,
  authorizeWorkspace,
  orgAdminForUser,
  readUser,
  serviceQuery,
  workspaceByPublicId,
} from "./model"

const workspaceId = { workspace_id: v.string() }
const policyScope = v.union(v.literal("org"), v.literal("user"), v.literal("workspace"))

type Db = GenericDatabaseReader<any> | GenericDatabaseWriter<any>
type PolicyScope = "org" | "user" | "workspace"
type PolicyRow = {
  _id: GenericId<"agent_extension_policy_overrides">
  scope: PolicyScope
  extension_id: string
  org_id?: GenericId<"orgs">
  user_id?: GenericId<"users">
  workspace_id?: GenericId<"workspaces">
  enabled: boolean
  reason?: string
  deleted_at?: number
}

function policy(row: PolicyRow) {
  return {
    id: row.extension_id,
    scope: row.scope,
    enabled: row.enabled,
    ...(row.reason ? { reason: row.reason } : {}),
  }
}

async function rowsBy(ctx: { db: Db }, index: "by_org" | "by_user" | "by_workspace", field: "org_id" | "user_id" | "workspace_id", value: unknown) {
  if (!value) return []
  return await ctx.db
    .query("agent_extension_policy_overrides")
    .withIndex(index, (q) => q.eq(field, value))
    .collect() as PolicyRow[]
}

async function policyRows(ctx: { db: Db }, input: {
  workspaceId: string
  userId?: unknown
  includeUser: boolean
}) {
  const workspace = await workspaceByPublicId(ctx.db, input.workspaceId)
  if (!workspace) return []
  return [
    ...await rowsBy(ctx, "by_org", "org_id", workspace.org_id),
    ...(input.includeUser ? await rowsBy(ctx, "by_user", "user_id", input.userId) : []),
    ...await rowsBy(ctx, "by_workspace", "workspace_id", workspace._id),
  ]
    .filter((item) => !item.deleted_at)
    .map(policy)
}

async function existingPolicy(ctx: { db: Db }, input: {
  workspace: Record<string, unknown>
  userId: unknown
  extensionId: string
  scope: PolicyScope
}) {
  const rows = input.scope === "org"
    ? await rowsBy(ctx, "by_org", "org_id", input.workspace.org_id)
    : input.scope === "user"
      ? await rowsBy(ctx, "by_user", "user_id", input.userId)
      : await rowsBy(ctx, "by_workspace", "workspace_id", input.workspace._id)
  return rows.find((item) => item.extension_id === input.extensionId && item.scope === input.scope)
}

// Pre-launch security review §4.2 — the scope-specific half of authorization.
//
// `authorizeWorkspace(workspace, "admin")` is necessary for every scope but
// SUFFICIENT only for the two whose blast radius is the workspace itself. An
// `org`-scoped row is keyed on `workspace.org_id`, and `policyRows` above reads
// org rows for EVERY workspace in that org — so an org-scoped write reaches
// workspaces the caller was never granted.
//
// The escalation that makes this reachable, not theoretical: a workspace owner
// grants an outsider a narrow single-workspace `admin` share
// (`workspaceShares.grant`, which requires no org membership); `shareRole` in
// convex/model.ts resolves that grant with no `org_memberships` check, so the
// outsider clears `authorizeWorkspace(..., "admin")`; `set({ scope: "org" })`
// then writes org-wide. External single-workspace collaboration is intentional
// and stays exactly as it is — the bug is treating workspace-admin as proof of
// org authority, and this is where that inference is severed.
async function authorizeScope(ctx: { db: Db }, input: {
  workspace: Record<string, unknown>
  userId: unknown
  scope: PolicyScope
}) {
  if (input.scope !== "org") return
  const orgId = input.workspace.org_id
  if (!orgId) throw new Error("Workspace has no org")
  if (!await orgAdminForUser(ctx.db, input.userId, orgId)) {
    throw new Error("org_policy_forbidden: org-scoped agent extension policy requires an org admin role")
  }
}

function scopedPatch(input: {
  workspace: Record<string, unknown>
  userId: unknown
  scope: PolicyScope
}) {
  if (input.scope === "org") {
    if (!input.workspace.org_id) throw new Error("Workspace has no org")
    return { org_id: input.workspace.org_id }
  }
  if (input.scope === "user") return { user_id: input.userId }
  return { workspace_id: input.workspace._id }
}

export const list = authedQuery({
  args: workspaceId,
  handler: async (ctx, args) => {
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace || !await authorizeWorkspace(ctx, workspace, "read")) return []
    return policyRows(ctx, {
      workspaceId: args.workspace_id,
      userId: (await readUser(ctx))._id,
      includeUser: true,
    })
  },
})

export const listForRuntime = serviceQuery({
  args: workspaceId,
  handler: async (ctx, args) => {
    return policyRows(ctx, {
      workspaceId: args.workspace_id,
      includeUser: false,
    })
  },
})

export const set = authedMutation({
  args: {
    ...workspaceId,
    extension_id: v.string(),
    scope: policyScope,
    enabled: v.boolean(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace || !await authorizeWorkspace(ctx, workspace, "admin")) throw new Error("Workspace not found")
    const user = await readUser(ctx)
    await authorizeScope(ctx, { workspace, userId: user._id, scope: args.scope })
    const now = Date.now()
    const patch = {
      scope: args.scope,
      extension_id: args.extension_id,
      ...scopedPatch({ workspace, userId: user._id, scope: args.scope }),
      enabled: args.enabled,
      reason: args.reason,
      updated_at: now,
      deleted_at: undefined,
    }
    const existing = await existingPolicy(ctx, {
      workspace,
      userId: user._id,
      extensionId: args.extension_id,
      scope: args.scope,
    })
    if (existing) {
      await ctx.db.patch(existing._id, patch)
      return { extension_id: args.extension_id, scope: args.scope }
    }
    await ctx.db.insert("agent_extension_policy_overrides", {
      created_at: now,
      ...patch,
    })
    return { extension_id: args.extension_id, scope: args.scope }
  },
})

export const remove = authedMutation({
  args: {
    ...workspaceId,
    extension_id: v.string(),
    scope: policyScope,
  },
  handler: async (ctx, args) => {
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace || !await authorizeWorkspace(ctx, workspace, "admin")) throw new Error("Workspace not found")
    const user = await readUser(ctx)
    // `remove` carries the identical weakness: it soft-deletes the org-wide row,
    // which silently re-enables (or re-disables) an extension for every
    // workspace in the org. Same bar as `set`.
    await authorizeScope(ctx, { workspace, userId: user._id, scope: args.scope })
    const existing = await existingPolicy(ctx, {
      workspace,
      userId: user._id,
      extensionId: args.extension_id,
      scope: args.scope,
    })
    if (existing && !existing.deleted_at) {
      await ctx.db.patch(existing._id, {
        deleted_at: Date.now(),
        updated_at: Date.now(),
      })
    }
    return { ok: true }
  },
})

export { remove as delete }
