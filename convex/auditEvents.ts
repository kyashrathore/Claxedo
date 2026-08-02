import { v } from "convex/values"
import {
  authedMutation,
  authedQuery,
  authorizeWorkspace,
  orgAdminForUser,
  readUser,
  upsertUser,
  workspaceByPublicId,
} from "./model"

// An unattributable event still records WHICH workspace was attempted — on the
// caller's own row, where it is a statement about the caller and not about the
// workspace's owner. `metadata` is already free-form and caller-controlled, so
// folding one reserved key in adds no new trust surface; a reader only consults
// this key on rows whose `workspace_id` is unset.
function unattributedMetadata(metadata: unknown, workspaceId: string) {
  const base = metadata === undefined
    ? {}
    : metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? metadata as Record<string, unknown>
      : { value: metadata }
  return { ...base, unattributed_workspace_id: workspaceId }
}

export const record = authedMutation({
  args: {
    action: v.string(),
    result: v.union(v.literal("allow"), v.literal("deny")),
    reason: v.optional(v.string()),
    workspace_id: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const user = await upsertUser(ctx)
    const requested = args.workspace_id ? await workspaceByPublicId(ctx.db, args.workspace_id) : undefined
    // Pre-launch security review §4.4 — `workspace_id` is caller-supplied and
    // this is an `authedMutation`, so before this check any signed-up user
    // could attribute rows (with free-form `metadata`) to another tenant's
    // workspace. `audit_events` is indexed `by_workspace_created`, so the first
    // audit UI or compliance export built on this table would read those forged
    // rows as that tenant's own history. Attribution now requires read access.
    //
    // It DEGRADES rather than throws, and that is the load-bearing choice:
    //
    // 1. The review's suggested `throw` breaks the caller that matters most.
    //    `workspaceOpenAuthorizationError`
    //    (packages/claxedo-server/src/routes/workspace-runtime-token-guards.ts)
    //    records `workspaces.open.denied` for a workspace whose authorization
    //    just FAILED — by construction the caller has no read role — and awaits
    //    the write with no catch. Throwing would turn a clean 403 into a 500
    //    and, worse, make the denial the one event that cannot be recorded.
    //    `connectionRateLimitError` and `controlPlaneRateLimitError` in the same
    //    file are on that path too.
    // 2. An audit write embedded in a request guard must be total. A logging
    //    call that can fail the request it is logging is a liability.
    // 3. Degrading makes "no such workspace" and "not your workspace"
    //    indistinguishable to the caller, so this is not an id-enumeration
    //    oracle. Rejecting only the unauthorized case would have created one;
    //    that is why an unresolvable id is handled identically rather than
    //    rejected.
    //
    // `user_id` is always the authenticated caller, so a row can only ever
    // describe its own author — what this closes is the ability to file that
    // row under someone else's workspace.
    const attributed = requested && await authorizeWorkspace(ctx, requested, "read") ? requested : undefined
    return await ctx.db.insert("audit_events", {
      user_id: user._id,
      workspace_id: attributed?._id,
      action: args.action,
      result: args.result,
      reason: args.reason,
      metadata: !args.workspace_id || attributed
        ? args.metadata
        : unattributedMetadata(args.metadata, args.workspace_id),
      created_at: Date.now(),
    })
  },
})

// ---------------------------------------------------------------------------
// Pre-launch security review §6.11 — the read path.
//
// `audit_events` had zero readers anywhere in the repo, which is why the write
// guard above matters: the table's integrity is only ever cashed in by a
// reader, and a log nobody can read has no value. These are those readers.
//
// The authorization rule, and why it is shaped this way:
//
// 1. WORKSPACE-attributed rows are read at the workspace ADMIN bar
//    (`listForWorkspace`). An audit history is an administrative surface, not a
//    collaboration surface: it exposes what every OTHER member of the workspace
//    did, including their denials. "editor" is the bar for doing work in a
//    workspace, not for reading the record of everyone who worked in it.
//
//    Admitting a single-workspace admin SHARE here is correct and is NOT the
//    §4.2 escalation: that finding was about an org-WIDE write authorized by a
//    one-workspace share. Here the grant and the blast radius are the same
//    object — the workspace whose owner deliberately granted admin over it —
//    and `directOrgRole` already maps org admin/owner onto workspace admin, so
//    org admins are admitted by the same check without a second rule.
//
// 2. UNATTRIBUTED rows (no `workspace_id`) are readable ONLY by their author
//    (`listMine`). The write path deliberately leaves `workspace_id` unset when
//    the caller lacked read access on the workspace it named, parking the
//    attempted id under `metadata.unattributed_workspace_id`. That key is
//    caller-controlled and unverified — it is a claim, not attribution. Routing
//    a row into any other viewer's results on the strength of it would rebuild
//    exactly the cross-tenant forgery the write guard closed, one layer up. The
//    row's only server-set fact is `user_id`, so its only safe audience is that
//    user: a forged attempted id can be shown back to the person who forged it
//    and to nobody else.
//
//    An org admin is NOT admitted to these rows either, and that is deliberate
//    rather than an oversight: the row carries no verified org linkage at all,
//    and users belong to several orgs (everyone has a personal one), so
//    surfacing them org-side would leak actions taken in a different org's
//    context.
//
// 3. ORG-WIDE reads (`listForOrg`, the compliance-export shape) require real
//    org authority via `orgAdminForUser` — the §4.2 bar — and then read only
//    through the org's workspaces. A one-workspace share must not become an
//    org-wide export, which is precisely the distinction `orgAdminForUser`
//    exists to draw.
//
// Every row is returned through `auditView`, which STRIPS the reserved
// `unattributed_workspace_id` key from `metadata` and re-surfaces it only for
// rows that actually have no `workspace_id`, under an explicitly unverified
// name. A reader must not be able to hand a UI a forged attribution that reads
// like a real one.
// ---------------------------------------------------------------------------

const AUDIT_DEFAULT_LIMIT = 50
const AUDIT_MAX_LIMIT = 200

function auditLimit(limit: number | undefined) {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return AUDIT_DEFAULT_LIMIT
  return Math.min(Math.floor(limit), AUDIT_MAX_LIMIT)
}

function metadataRecord(metadata: unknown) {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : undefined
}

/**
 * The attempted-but-unauthorized workspace id a row carries, if any.
 *
 * Only consulted for rows whose `workspace_id` is UNSET — the exact contract
 * `unattributedMetadata` above documents. On an attributed row the same key can
 * only be caller-supplied noise, and is dropped rather than read.
 */
function attemptedWorkspaceId(row: Record<string, unknown>) {
  if (row.workspace_id !== undefined) return undefined
  const value = metadataRecord(row.metadata)?.unattributed_workspace_id
  return typeof value === "string" ? value : undefined
}

function publicMetadata(metadata: unknown) {
  const record = metadataRecord(metadata)
  if (!record) return metadata
  const { unattributed_workspace_id: _reserved, ...rest } = record
  return rest
}

function auditView(row: Record<string, unknown>, workspacePublicId: string | undefined) {
  const attempted = attemptedWorkspaceId(row)
  return {
    id: String(row._id),
    action: row.action as string,
    result: row.result as "allow" | "deny",
    reason: row.reason as string | undefined,
    created_at: row.created_at as number,
    user_id: row.user_id === undefined ? undefined : String(row.user_id),
    workspace_id: workspacePublicId,
    // Named for what it is: a claim the caller made, which the write path
    // refused to turn into attribution. Never a `workspace_id`.
    unverified_attempted_workspace_id: attempted,
    metadata: publicMetadata(row.metadata),
  }
}

function auditPage(
  ctx: { db: any },
  index: "by_workspace_created" | "by_user_created",
  field: "workspace_id" | "user_id",
  value: unknown,
  input: { limit?: number; before?: number },
) {
  return ctx.db
    .query("audit_events")
    .withIndex(index, (query: any) => {
      const scoped = query.eq(field, value)
      return typeof input.before === "number" ? scoped.lt("created_at", input.before) : scoped
    })
    .order("desc")
    .take(auditLimit(input.limit))
}

/** Audit history for ONE workspace. Workspace admin (see rule 1 above). */
export const listForWorkspace = authedQuery({
  args: {
    workspace_id: v.string(),
    limit: v.optional(v.number()),
    before: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    // One error for "no such workspace" and "not yours", matching the write
    // path: distinguishing them would turn this into an id-enumeration oracle.
    if (!workspace || !(await authorizeWorkspace(ctx, workspace, "admin"))) throw new Error("Workspace not found")
    const rows = await auditPage(ctx, "by_workspace_created", "workspace_id", workspace._id, args)
    return rows.map((row: Record<string, unknown>) => auditView(row, args.workspace_id))
  },
})

/**
 * The caller's OWN audit history, across every workspace and including the
 * unattributed rows nobody else may see (rule 2 above).
 */
export const listMine = authedQuery({
  args: {
    limit: v.optional(v.number()),
    before: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await readUser(ctx)
    const rows = await auditPage(ctx, "by_user_created", "user_id", user._id, args)
    const publicIds = new Map<string, string | undefined>()
    return await Promise.all(rows.map(async (row: Record<string, unknown>) => {
      const workspaceId = row.workspace_id
      if (workspaceId === undefined) return auditView(row, undefined)
      const key = String(workspaceId)
      if (!publicIds.has(key)) {
        const workspace = await ctx.db.get(workspaceId as never)
        publicIds.set(key, typeof workspace?.workspace_id === "string" ? workspace.workspace_id : undefined)
      }
      return auditView(row, publicIds.get(key))
    }))
  },
})

/**
 * Org-wide audit history — the compliance-export shape. Org ADMIN via
 * `orgAdminForUser` (rule 3 above), never a workspace share.
 *
 * Reads through the org's workspaces because `audit_events.org_id` is a column
 * nothing writes: the only rows with a verified org linkage are the ones filed
 * under a workspace that belongs to the org. Unattributed rows are absent by
 * construction, which is the point.
 */
export const listForOrg = authedQuery({
  args: {
    org_id: v.id("orgs"),
    limit: v.optional(v.number()),
    before: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await readUser(ctx)
    if (!(await orgAdminForUser(ctx.db, user._id, args.org_id))) throw new Error("Organization not found")
    const limit = auditLimit(args.limit)
    const workspaces = await ctx.db
      .query("workspaces")
      .withIndex("by_org", (query: any) => query.eq("org_id", args.org_id))
      .collect()
    // Per-workspace pages merged newest-first. Each page is already bounded by
    // `limit`, so the merge can never return more than it reads.
    const pages = await Promise.all(workspaces.map(async (workspace: Record<string, unknown>) => {
      const rows = await auditPage(ctx, "by_workspace_created", "workspace_id", workspace._id, {
        ...args,
        limit,
      })
      return rows.map((row: Record<string, unknown>) =>
        auditView(row, typeof workspace.workspace_id === "string" ? workspace.workspace_id : undefined))
    }))
    return pages.flat()
      .sort((left, right) => right.created_at - left.created_at)
      .slice(0, limit)
  },
})
