import { v } from "convex/values"
import { orgMembershipTombstone } from "./clerkTombstones"
import {
  authedMutation,
  authedQuery,
  cronMutation,
  orgByClerkOrgId,
  orgMembership,
  readUser,
  serviceMutation,
  serviceQuery,
  sha256Hex,
  upsertUser,
  userByClerkSubject,
  webhookMutation,
} from "./model"
import { isLiveLease } from "./sandboxLeases"
import { WORKGRAPH_OWNER_TABLES, ownerDeletionIndex } from "./workgraphOwnerDeletion"
import { revokeWorkspaceUserTokens } from "./runtimeAccessTokens"
import { ensureDefaultTeamMembership, removeDefaultTeamMembership } from "./teams"

export async function personalOrgForUser(ctx: any, user: { _id: unknown; name?: string; email?: string }) {
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

export const listForMe = authedQuery({
  args: {},
  handler: async (ctx) => {
    const user = await readUser(ctx)
    const memberships = await ctx.db
      .query("org_memberships")
      .withIndex("by_user", (q) => q.eq("user_id", user._id))
      .collect()

    return await Promise.all(
      memberships.map(async (membership) => {
        const org = await ctx.db.get(membership.org_id)
        return org
          ? {
              org_id: org._id,
              clerk_org_id: org.clerk_org_id,
              slug: org.slug,
              name: org.name,
              role: membership.role,
            }
          : undefined
      }),
    ).then((items) => items.filter((item) => item !== undefined))
  },
})

export const ensurePersonalOrg = authedMutation({
  args: {},
  handler: async (ctx) => {
    const user = await upsertUser(ctx)
    const org = await personalOrgForUser(ctx, user)
    return {
      org_id: org._id,
      clerk_org_id: org.clerk_org_id,
      role: "owner",
    }
  },
})

export const createTeam = authedMutation({
  args: {
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const name = args.name.trim()
    if (!name) throw new Error("team_name_required")
    const user = await upsertUser(ctx)
    const now = Date.now()
    // Creates an Org (collaborative tenant). Nested default Team is seeded so
    // Org→Team nesting is available immediately (D17).
    const orgId = await ctx.db.insert("orgs", {
      name,
      kind: "team",
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
    const defaultTeamPublicId = `team_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
    const defaultTeamId = await ctx.db.insert("teams", {
      public_id: defaultTeamPublicId,
      org_id: orgId,
      name: "Everyone",
      is_default: true,
      created_by_user_id: user._id,
      created_at: now,
      updated_at: now,
    })
    await ctx.db.insert("team_memberships", {
      team_id: defaultTeamId,
      user_id: user._id,
      role: "owner",
      created_at: now,
      updated_at: now,
    })
    return {
      org_id: orgId,
      name,
      role: "owner" as const,
      default_team_id: defaultTeamPublicId,
    }
  },
})

export const resolveForMe = authedMutation({
  args: {
    clerk_org_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await upsertUser(ctx)
    if (args.clerk_org_id) {
      const org = await orgByClerkOrgId(ctx.db, args.clerk_org_id)
      if (!org || org.deleted_at) throw new Error("Organization not found")
      const membership = await orgMembership(ctx.db, org._id, user._id)
      if (membership) return { org_id: org._id, clerk_org_id: org.clerk_org_id, role: membership.role }
      throw new Error("Organization membership is required")
    }
    const personal = await personalOrgForUser(ctx, user)
    return { org_id: personal._id, clerk_org_id: personal.clerk_org_id, role: "owner" }
  },
})

export const setActive = authedQuery({
  args: {
    clerk_org_id: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await readUser(ctx)
    const org = await orgByClerkOrgId(ctx.db, args.clerk_org_id)
    if (!org) throw new Error("Org not found")
    const membership = await orgMembership(ctx.db, org._id, user._id)
    if (!membership) throw new Error("Org not found")
    return {
      org_id: org._id,
      clerk_org_id: org.clerk_org_id,
      role: membership.role,
    }
  },
})

function clerkRole(input: unknown): "admin" | "member" {
  const value = typeof input === "string" ? input : ""
  if (value.includes("admin")) return "admin"
  return "member"
}

function eventTime(data: Record<string, any>) {
  const value = data.updated_at ?? data.created_at
  return typeof value === "number" ? value : Date.now()
}

async function upsertClerkUser(ctx: any, data: Record<string, any>) {
  const subject = typeof data.id === "string" ? data.id : undefined
  if (!subject) return
  const existing = await ctx.db
    .query("users")
    .withIndex("by_clerk_subject", (q: any) => q.eq("clerk_subject", subject))
    .unique()
  const now = Date.now()
  const patch = {
    public_id: existing?.public_id ?? `usr_${crypto.randomUUID()}`,
    clerk_subject: subject,
    email: data.email_addresses?.[0]?.email_address,
    name: [data.first_name, data.last_name].filter(Boolean).join(" ") || undefined,
    image_url: data.image_url,
    updated_at: now,
  }
  if (existing) {
    await ctx.db.patch(existing._id, patch)
    return existing._id
  }
  return await ctx.db.insert("users", {
    token_identifier: `clerk:${subject}`,
    issuer: "clerk",
    kind: "human",
    ...patch,
    created_at: now,
  })
}

async function upsertClerkOrg(ctx: any, data: Record<string, any>) {
  const clerkOrgId = typeof data.id === "string" ? data.id : undefined
  if (!clerkOrgId) return
  const existing = await orgByClerkOrgId(ctx.db, clerkOrgId)
  const updatedAt = eventTime(data)
  if (existing?.clerk_updated_at && existing.clerk_updated_at > updatedAt) return existing._id
  const patch = {
    clerk_org_id: clerkOrgId,
    slug: data.slug,
    name: data.name ?? data.slug ?? clerkOrgId,
    kind: "clerk" as const,
    deleted_at: undefined,
    // §6.12: an org that reappears in Clerk inside the retention grace window
    // CANCELS its own purge. Clearing this here, next to `deleted_at`, is what
    // makes the window a real undo rather than a countdown nobody can stop.
    purge_requested_at: undefined,
    clerk_updated_at: updatedAt,
    updated_at: Date.now(),
  }
  if (existing) {
    await ctx.db.patch(existing._id, patch)
    return existing._id
  }
  return await ctx.db.insert("orgs", {
    ...patch,
    created_at: Date.now(),
  })
}

async function upsertClerkMembership(ctx: any, data: Record<string, any>) {
  const orgId = await upsertClerkOrg(ctx, data.organization ?? {})
  const clerkSubject = data.public_user_data?.user_id ?? data.user_id
  if (!orgId || typeof clerkSubject !== "string") return
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_subject", (q: any) => q.eq("clerk_subject", clerkSubject))
    .unique()
  if (!user) return
  const updatedAt = eventTime(data)
  const existing = await orgMembership(ctx.db, orgId, user._id)
  if (existing?.clerk_updated_at && existing.clerk_updated_at > updatedAt) return

  // W6.3 ORDERING GUARD. The `clerk_updated_at` check above only protects rows
  // that still EXIST — once `.deleted` has removed the row there is nothing left
  // to compare against, so a delayed `organizationMembership.created`
  // redelivery arriving afterwards re-inserted the membership and restored
  // access Clerk had already revoked. Svix retries a message for ~27.5h and
  // disables an endpoint only after 5 days of failures, so a create arriving
  // long after the delete it should have preceded is ordinary behavior.
  //
  // The tombstone is the missing left-hand side of that same comparison: it
  // remembers the revocation's timestamp after the row is gone, so the guard
  // becomes the timestamp test it always should have been. Note this is NOT a
  // permanent block — a genuine later re-join carries a NEWER timestamp, wins,
  // and clears the tombstone on the way through (below).
  const clerkOrgId = data.organization?.id
  const tombstone =
    typeof clerkOrgId === "string" ? await orgMembershipTombstone(ctx.db, clerkOrgId, clerkSubject) : undefined
  if (tombstone && tombstone.clerk_updated_at >= updatedAt) return
  // A create that BEAT the tombstone is a genuine re-join, so the tombstone has
  // done its job and is retired here rather than left to expire. Leaving it
  // would be actively wrong, not merely untidy: the next revoke-then-rejoin
  // cycle would compare against this stale, older revocation instead of the
  // newer one, and admit a create it should have dropped.
  if (tombstone) await ctx.db.delete(tombstone._id)
  const patch = {
    role: clerkRole(data.role),
    clerk_updated_at: updatedAt,
    updated_at: Date.now(),
  }
  if (existing) {
    if ((existing.role === "owner" || existing.role === "admin") && patch.role === "member") {
      await revokeOrgWorkspaceTokens(ctx, orgId, user._id, Date.now())
    }
    await ctx.db.patch(existing._id, patch)
    await ensureDefaultTeamMembership(ctx, {
      orgId,
      userId: user._id,
      role: patch.role,
      creatorUserId: user._id,
      now: patch.updated_at,
    })
    return
  }
  // F1 (adversarial review): the seat hard-block used to throw here, inside the
  // Svix-verified Clerk→Convex mirror. That was the WRONG layer: the member
  // already exists in Clerk by the time this runs (so the throw cannot block
  // the join), and throwing 500s the whole Svix delivery — wedging the entire
  // mirror, including membership REVOCATIONS. The mirror must never 500 on seat
  // count. Seat enforcement now lives at the entitlement/capability layer
  // (src/billing/entitlement.ts: an org OVER its licensed seats is denied
  // hosted "cloud-workspace"/"hosted-connections" access), and Clerk's
  // membership count here is treated as advisory — it always syncs cleanly.
  await ctx.db.insert("org_memberships", {
    org_id: orgId,
    user_id: user._id,
    ...patch,
    created_at: Date.now(),
  })
  await ensureDefaultTeamMembership(ctx, {
    orgId,
    userId: user._id,
    role: patch.role,
    creatorUserId: user._id,
    now: patch.updated_at,
  })
}

async function deleteClerkMembership(ctx: any, data: Record<string, any>) {
  const clerkOrgId = data.organization?.id
  const clerkSubject = data.public_user_data?.user_id ?? data.user_id
  if (typeof clerkOrgId !== "string" || typeof clerkSubject !== "string") return
  const updatedAt = eventTime(data)
  // W6.3: the tombstone is written FIRST, and unconditionally — before the org
  // and user rows are even resolved. Both orderings matter.
  //
  // Unconditional, because the reason a membership row is missing here is very
  // often that its `.created` has not arrived yet (Svix does not guarantee
  // order). Recording the revocation only when there is something to delete
  // would skip exactly the case the guard exists for: `.deleted` first,
  // `.created` second. That path leaves nothing behind to compare against and
  // is precisely how the resurrection bug fires.
  //
  // First, because a revocation that is applied but not recorded is a window in
  // which a late create wins. Writing the fence before the act it fences means
  // there is no such window — and a tombstone with no deletion is inert, so the
  // conservative failure direction is the cheap one.
  await writeMembershipTombstone(ctx, clerkOrgId, clerkSubject, updatedAt)
  const org = await orgByClerkOrgId(ctx.db, clerkOrgId)
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_subject", (q: any) => q.eq("clerk_subject", clerkSubject))
    .unique()
  if (!org || !user) return
  const membership = await orgMembership(ctx.db, org._id, user._id)
  if (!membership) return
  const revokedRole = membership.role
  await revokeOrgWorkspaceTokens(ctx, org._id, user._id, Date.now())
  await ctx.db.delete(membership._id)
  await removeDefaultTeamMembership(ctx, { orgId: org._id, userId: user._id })
  // W6.3: the delete path previously wrote NO audit record at all, which made
  // the single most security-relevant event in the mirror — access being taken
  // away, or failing to be — completely invisible after the fact. `audit_events`
  // is the repo's existing append-only log with a real reader
  // (`auditEvents.listForOrg`, org-admin gated), so this reuses it rather than
  // adding a second log with no readers.
  await recordMembershipAudit(ctx, {
    orgId: org._id,
    userId: user._id,
    action: "org.membership.revoked",
    source: "webhook",
    metadata: {
      clerk_org_id: clerkOrgId,
      clerk_subject: clerkSubject,
      revoked_role: revokedRole,
      clerk_updated_at: updatedAt,
    },
  })
}

export async function revokeOrgWorkspaceTokens(ctx: any, orgId: unknown, userId: unknown, now: number) {
  const workspaces = await ctx.db
    .query("workspaces")
    .withIndex("by_org", (q: any) => q.eq("org_id", orgId))
    .collect()
  for (const workspace of workspaces.filter((workspace: any) => !workspace.deleted_at)) {
    await revokeWorkspaceUserTokens(ctx, workspace._id, userId, now)
  }
}

/**
 * Record that the Clerk webhook channel delivered, and clear any stale flag.
 *
 * Self-clearing on purpose, exactly like the billing mirror's reconcile flag
 * (set by the sweep, cleared by the next state apply): a flag an operator has to
 * clear by hand is a flag that stays lit after the incident and stops meaning
 * anything.
 */
async function stampClerkWebhookSeen(ctx: any, type: string) {
  const now = Date.now()
  const state = await ctx.db
    .query("clerk_sync_state")
    .withIndex("by_scope", (q: any) => q.eq("scope", "clerk"))
    .unique()
  const patch = {
    last_webhook_at: now,
    last_webhook_type: type,
    webhook_stale_flagged_at: undefined,
    updated_at: now,
  }
  if (state) {
    await ctx.db.patch(state._id, patch)
    return
  }
  await ctx.db.insert("clerk_sync_state", { scope: "clerk" as const, ...patch, created_at: now })
}

/**
 * Remember a revocation so a late `.created` cannot undo it.
 *
 * Keeps the LATEST revocation when one is already present: an older `.deleted`
 * arriving late must not lower the bar that a subsequent late `.created` has to
 * clear.
 */
async function writeMembershipTombstone(ctx: any, clerkOrgId: string, clerkSubject: string, clerkUpdatedAt: number) {
  const existing = await orgMembershipTombstone(ctx.db, clerkOrgId, clerkSubject)
  if (existing) {
    if (existing.clerk_updated_at >= clerkUpdatedAt) return
    await ctx.db.patch(existing._id, { clerk_updated_at: clerkUpdatedAt, source: "webhook" })
    return
  }
  await ctx.db.insert("clerk_membership_tombstones", {
    clerk_org_id: clerkOrgId,
    clerk_subject: clerkSubject,
    clerk_updated_at: clerkUpdatedAt,
    source: "webhook",
    created_at: Date.now(),
  })
}

/**
 * One membership audit row. `result: "allow"` because the schema's `result` is
 * an allow/deny verdict on an ATTEMPT, and these rows record a completed mirror
 * action rather than a refused one; the action name carries what happened and
 * `metadata.source` distinguishes webhook from sweep.
 */
async function recordMembershipAudit(
  ctx: any,
  input: {
    orgId: unknown
    userId: unknown
    action: string
    source: "webhook" | "sweep"
    metadata: Record<string, unknown>
  },
) {
  await ctx.db.insert("audit_events", {
    user_id: input.userId,
    org_id: input.orgId,
    action: input.action,
    result: "allow" as const,
    reason: input.source,
    metadata: { ...input.metadata, source: input.source },
    created_at: Date.now(),
  })
}

// Applier for the Svix-verified Clerk webhook http action (convex/http.ts),
// which invokes it via `ctx.runMutation`.
//
// INTERNAL, never public. The Svix signature check lives in the httpAction, so
// a public applier is a second, unauthenticated door into the same authority
// with the signature check skipped. As a `publicMutation` this was directly
// callable by any Convex client holding the deployment URL (public: it ships in
// the app bundle as `VITE_CONVEX_URL`), and `organizationMembership.created`
// let the caller mint themselves an `org:admin` membership in an arbitrary org
// — which `directOrgRole` resolves to admin on every workspace in that org.
// `webhookMutation` gives it internal visibility — callable ONLY from inside
// the deployment. `ctx.runMutation` in http.ts is unaffected because it resolves
// by UDF path, not visibility.
export const applyClerkWebhook = webhookMutation({
  args: {
    type: v.string(),
    data: v.any(),
  },
  handler: async (ctx, args) => {
    const data = args.data as Record<string, any>
    // W6.3 webhook liveness. Stamped for EVERY verified event, including types
    // this applier does not handle: the question the flag answers is "is the
    // Clerk→Convex webhook channel alive at all", and an unhandled event proves
    // the channel is delivering just as well as a handled one. Svix disables an
    // endpoint after 5 days of failed deliveries, which stops every type at
    // once — that is the failure this detects.
    await stampClerkWebhookSeen(ctx, args.type)
    if (args.type === "user.created") await upsertClerkUser(ctx, data)
    if (args.type === "organization.created" || args.type === "organization.updated") await upsertClerkOrg(ctx, data)
    if (args.type === "organizationMembership.created" || args.type === "organizationMembership.updated")
      await upsertClerkMembership(ctx, data)
    if (args.type === "organizationMembership.deleted") await deleteClerkMembership(ctx, data)
    if (args.type === "organization.deleted") {
      const org = typeof data.id === "string" ? await orgByClerkOrgId(ctx.db, data.id) : undefined
      // §6.12: `deleted_at` alone revokes ACCESS (`directOrgRole` stops
      // resolving a role) but retains every row forever. `purge_requested_at`
      // is the separate, explicit request that the data itself go — the only
      // write of that field anywhere, and the clock the grace window measures
      // from. The purge is driven from here, not performed here: see
      // `purgeDeletedOrgs`.
      if (org && !org.purge_requested_at) {
        await ctx.db.patch(org._id, {
          deleted_at: Date.now(),
          purge_requested_at: Date.now(),
          updated_at: Date.now(),
        })
      }
    }
    return { ok: true }
  },
})

/**
 * F12 (adversarial review): membership re-check for the hosted connections gate
 * (src/connections-host/connections-host.ts). The connections host derives the
 * team partition from the caller's verified Clerk `org_id` claim; D2 says JWT
 * org claims must not be the sole authorization input, so the host re-checks
 * that the subject is ACTUALLY a member of that org in Convex before granting
 * the team partition. Service-token gated (machine principal — the Worker/host,
 * which holds no end-user identity for the connections turn). Returns a plain
 * membership verdict; a stale/mis-synced claim with no backing membership row
 * resolves to `{ member: false }` and the host answers 403.
 */
export const membershipByClerkIds = serviceQuery({
  args: {
    clerk_org_id: v.string(),
    clerk_subject: v.string(),
  },
  handler: async (ctx, args) => {
    const org = await orgByClerkOrgId(ctx.db, args.clerk_org_id)
    if (!org || org.deleted_at) return { member: false as const }
    const user = await userByClerkSubject(ctx.db, args.clerk_subject)
    if (!user) return { member: false as const }
    const membership = await orgMembership(ctx.db, org._id, user._id)
    return membership
      ? { member: true as const, org_id: String(org._id), user_id: String(user._id), role: membership.role as string }
      : { member: false as const }
  },
})

/**
 * Personal-org counterpart of `membershipByClerkIds` for the hosted connections
 * gate (src/hosts/workgraph/hosted/connections-setup.ts): sessions without a
 * Clerk organization (personal accounts) resolve to the caller's personal org —
 * the same scope `resolveForMe` hands every other hosted surface. Mutation
 * because `personalOrgForUser` auto-provisions the org row on first use.
 * Service-token gated (machine principal), like `membershipByClerkIds`.
 */
export const personalMembershipForClerkSubject = serviceMutation({
  args: {
    clerk_subject: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await userByClerkSubject(ctx.db, args.clerk_subject)
    if (!user) return { member: false as const }
    const org = await personalOrgForUser(ctx, user)
    return { member: true as const, org_id: String(org._id), user_id: String(user._id), role: "owner" }
  },
})

// ===========================================================================
// Pre-launch security review §6.12 — organization deletion cascade.
//
// `organization.deleted` used to patch `deleted_at` and stop. Every workspace,
// session, message, audit row, WorkGraph record, usage fact and stored policy
// belonging to that org survived indefinitely: a data-retention and privacy
// problem, and a real one for a product about to take public signups.
//
// This is a deliberate mirror of the WorkGraph owner-deletion machinery in
// convex/workgraphOwnerDeletion.ts — same barrier/receipt pair, same lease
// renewal, same quiescence precondition, same bounded-batch resumability —
// because that design has already been through conformance and there is no
// reason for two shapes of destructive cascade in one codebase.
//
// WHAT IS DIFFERENT, and why:
//
// - No `targets` snapshot for external cleanup. WorkGraph needs one because an
//   execution envelope is an external object with no independent sweep: if the
//   rows naming it are deleted first, nothing remembers to destroy it. Sandbox
//   infrastructure is not like that. `sandboxManager.garbageCollect()` is
//   level-triggered from the DRIVER's own inventory (`driver.list()`) and
//   destroys any resource without a live lease, so deleting lease rows cannot
//   orphan a VM — it makes the sweep MORE likely to reclaim it, not less.
//   Copying a field with no consumer would be cargo-culting the prior art
//   rather than mirroring it.
//
// - The receipt's `scope_hash` fingerprints the purge REQUEST (org + clerk org
//   id + `purge_requested_at`) rather than the row set. A row-set hash
//   necessarily drifts as batches delete rows, which is why the prior art only
//   re-verifies it in its pre-deletion state; a request fingerprint is stable
//   across every batch AND still refuses a receipt left over from an earlier
//   delete-restore-delete cycle, because a restore clears `purge_requested_at`
//   and the next deletion stamps a new one.
//
// FIRING IT IS DELIBERATELY HARD. Six independent conditions, none of which a
// single mistake satisfies:
//   1. `purge_requested_at` is set, and the ONLY writer is the Svix-verified
//      `organization.deleted` applier above.
//   2. `deleted_at` is set.
//   3. The org has a `clerk_org_id`. Personal orgs have none, so the entire
//      cascade is structurally unreachable for them — the one org every user
//      has, and the one whose loss would be unrecoverable.
//   4. The caller echoes that `clerk_org_id` back as an explicit confirmation.
//   5. The org is quiescent (below).
//   6. The retention grace window has elapsed (cron path), during which a
//      restore in Clerk cancels the purge outright.
// ===========================================================================

/** Mirrors `WORKGRAPH_OWNER_DELETION_BATCH_SIZE`: the service-driven budget. */
export const ORG_DELETION_BATCH_SIZE = 8

/**
 * How deep into the due-purge queue one tick looks (W5 index pass).
 *
 * The tick only ever purges the OLDEST due org, so this bounds the read-set,
 * not the work: it exists so the handler's cost is a constant rather than a
 * function of queue depth, which is what keeps it under Convex's per-
 * transaction document-read cap no matter how many orgs are pending. The only
 * observable effect of the bound is that the reported `due` count saturates
 * here — the org actually purged is unaffected, because the index returns the
 * queue oldest-first.
 */
export const ORG_PURGE_QUEUE_SCAN_LIMIT = 256

/**
 * Retention grace window for the cron-driven purge. A week is long enough for
 * "we deleted the wrong org in Clerk" to be noticed and undone by re-creating
 * it (which clears `purge_requested_at`), and short enough that a deleted
 * tenant's data is not retained indefinitely.
 */
export const ORG_DELETION_GRACE_MS = 7 * 24 * 60 * 60 * 1_000

const orgDeletionLeaseMs = 5 * 60 * 1_000

type ScopedRows = Readonly<{ table: string; index: string; field: string }>
type ChildRows = ScopedRows & Readonly<{ parentKey: string }>
type ParentCascade = Readonly<ScopedRows & { children: readonly ChildRows[] }>

/**
 * Tables keyed DIRECTLY on the org's Convex document id.
 *
 * The WorkGraph half is imported rather than re-listed: `WORKGRAPH_OWNER_TABLES`
 * is already the maintained enumeration of owner-scoped WorkGraph state, and a
 * second copy here would be a list that silently rots.
 *
 * FIXED 2026-07-30: the index per table is resolved through
 * `ownerDeletionIndex`, not hardcoded to `by_tenant`. This block previously
 * asserted that "every one of those tables carries `organization_id` as the
 * first column of its `by_tenant` index" — three of them declare no `by_tenant`
 * at all (`workgraph_dirty_events`, `workgraph_agent_checkpoints`,
 * `workgraph_session_bindings`), so against the real Convex runtime the ORG
 * cascade threw on them exactly as the per-owner cascade did. Sharing one
 * resolver is what stops the two cascades from disagreeing again.
 *
 * Only the `organization_id` prefix is pinned here (`field` below), which every
 * resolved index still leads with — see the tenancy-scope assertions in
 * `claxedo-server/src/control-plane/convex-unbounded-read-guard.test.ts`.
 */
export const ORG_DIRECT_TABLES: readonly ScopedRows[] = [
  // One deliberate exception to the WorkGraph import: the tenancy-migration
  // quarantine's organization is ambiguous by construction (see
  // ORG_RETAINED_TABLES below), so the org cascade retains it. The per-OWNER
  // WorkGraph purge still deletes it through its `by_owner` index, which is
  // exact.
  ...WORKGRAPH_OWNER_TABLES.filter((table) => table !== "workgraph_tenancy_migration_quarantine").map((table) => ({
    table,
    index: ownerDeletionIndex(table),
    field: "organization_id",
  })),
  // A leftover fence from an interrupted per-owner deletion. Quiescence refuses
  // while one is LIVE; this clears any that outlived their operation.
  { table: "workgraph_owner_deletion_barriers", index: "by_tenant", field: "organization_id" },
  { table: "org_memberships", index: "by_org_user", field: "org_id" },
  { table: "agent_extension_policy_overrides", index: "by_org", field: "org_id" },
  // Grants handed TO this org over OTHER orgs' workspaces. The reverse
  // direction (grants over this org's workspaces) is a workspace child below.
  { table: "workspace_share_grants", index: "by_org", field: "granted_to_org_id" },
  // Session grants targeted at this org (interim Phase-1 shape; D18).
  { table: "session_share_grants", index: "by_org", field: "granted_to_org_id" },
]

/**
 * Tables keyed on the CLERK org id string rather than the Convex document id —
 * the W5 metering id space (convex/schema.ts, `runtime_leases.org_id`). Both
 * carry per-user usage history and are personal data under any retention
 * policy.
 *
 * `sandbox_lease_events` also lives in this id space but has no org index, so
 * it is purged as a workspace child instead; every fact names the workspace
 * whose lease produced it, which is exact.
 */
export const ORG_CLERK_TABLES: readonly ScopedRows[] = [
  { table: "sandbox_usage_daily", index: "by_org_date", field: "org_id" },
  { table: "llm_usage_events", index: "by_org_user", field: "org_id" },
  { table: "llm_usage_revisions", index: "by_turn_revision", field: "org_id" },
  { table: "llm_usage_daily", index: "by_org_date", field: "org_id" },
  { table: "llm_usage_breakdown_daily", index: "by_org_user_dimension_date", field: "org_id" },
  // W6.3. Also Clerk-id-keyed, and purged rather than retained for a reason
  // worth stating: a tombstone names a `clerk_subject`, so it is a durable
  // record that a specific person was removed from a specific org. Retaining it
  // past the org's own purge would leave the deleted tenant's membership history
  // behind — precisely what §6.12 exists to prevent. It is also inert once the
  // org is gone: the only readers key on a live org's Clerk id.
  { table: "clerk_membership_tombstones", index: "by_membership", field: "clerk_org_id" },
]

/** Workspace children keyed on the workspace DOCUMENT id. */
export const ORG_WORKSPACE_DOC_TABLES: readonly ScopedRows[] = [
  { table: "workspace_memberships", index: "by_workspace_user", field: "workspace_id" },
  { table: "workspace_share_grants", index: "by_workspace", field: "workspace_id" },
  { table: "session_share_grants", index: "by_workspace", field: "workspace_id" },
  { table: "local_host_links", index: "by_workspace", field: "workspace_id" },
  { table: "runtime_access_tokens", index: "by_workspace_user", field: "workspace_id" },
  { table: "agent_extension_installs", index: "by_workspace", field: "workspace_id" },
  { table: "agent_extension_policy_overrides", index: "by_workspace", field: "workspace_id" },
  { table: "audit_events", index: "by_workspace_created", field: "workspace_id" },
]

/** Workspace children keyed on the PUBLIC workspace id string. */
export const ORG_WORKSPACE_PUBLIC_TABLES: readonly ScopedRows[] = [
  { table: "host_attestation_challenges", index: "by_workspace", field: "workspace_id" },
  // Owner intent that host H serves workspace X. Dies with the workspace: the
  // enrollment (user-owned, retained) stays, but nothing routable remains.
  { table: "host_workspace_assignments", index: "by_workspace", field: "workspace_id" },
  { table: "runtime_leases", index: "by_workspace_id", field: "workspace_id" },
  { table: "sandbox_lease_events", index: "by_workspace_id", field: "workspace_id" },
  { table: "wakes", index: "by_workspace_created", field: "workspace_id" },
]

const ORG_SESSION_CASCADE: ParentCascade = {
  table: "session_history",
  index: "by_workspace_updated",
  field: "workspace_id",
  children: [
    // `session_messages` has no workspace index at all — only
    // `by_session_ordinal` — so transcripts are only reachable through their
    // session row. Deleting sessions first would strand every message.
    { table: "session_messages", index: "by_session_ordinal", field: "session_id", parentKey: "session_id" },
    // Same reachability, same reason to purge: a participant row names a
    // specific PERSON who could read a specific session's transcript, which is
    // personal data under any retention policy. Its only scoping indexes are
    // `by_session_user` and `by_user` — neither names a workspace or an org —
    // so like the transcript it is only reachable through its session.
    { table: "session_participants", index: "by_session_user", field: "session_id", parentKey: "session_id" },
  ],
}

/**
 * Canonical private-session state is workspace-owned, but every dependent row
 * is indexed by the immutable session id rather than by organization. Drain
 * those children before the session row so an interrupted batched purge can
 * never strand transcript, participant, registration, or fencing state.
 */
export const ORG_PRIVATE_SESSION_CASCADE: ParentCascade = {
  table: "private_sessions",
  index: "by_workspace_updated",
  field: "workspace_id",
  children: [
    { table: "private_session_registrations", index: "by_session_id", field: "session_id", parentKey: "session_id" },
    { table: "private_session_participants", index: "by_session_actor", field: "session_id", parentKey: "session_id" },
    { table: "private_session_messages", index: "by_session_ordinal", field: "session_id", parentKey: "session_id" },
    { table: "private_session_turn_leases", index: "by_session_id", field: "session_id", parentKey: "session_id" },
    { table: "private_session_turn_producers", index: "by_session_turn", field: "session_id", parentKey: "session_id" },
  ],
}

const ORG_PROJECT_CASCADE: ParentCascade = {
  table: "projects",
  index: "by_org",
  field: "org_id",
  children: [
    { table: "project_memberships", index: "by_project_user", field: "project_id", parentKey: "project_id" },
    // Legacy rows written before reconcileProjectMembershipProjectIds keyed
    // `project_id` on the project's Convex doc _id rather than its public id.
    // Drain those too so an org purge cannot orphan personal membership rows if
    // it runs before that migration. Disjoint from the pass above (a row holds
    // one keying or the other), so no double-delete.
    { table: "project_memberships", index: "by_project_user", field: "project_id", parentKey: "_id" },
    // Team project grants keyed by project public id (or legacy doc id).
    { table: "team_project_grants", index: "by_project", field: "project_id", parentKey: "project_id" },
    { table: "team_project_grants", index: "by_project", field: "project_id", parentKey: "_id" },
  ],
}

/**
 * Nested teams (D17). Memberships and remaining team-targeted grants must
 * drain before the team row; teams themselves drain before org membership.
 */
const ORG_TEAM_CASCADE: ParentCascade = {
  table: "teams",
  index: "by_org",
  field: "org_id",
  children: [
    { table: "team_memberships", index: "by_team", field: "team_id", parentKey: "_id" },
    { table: "team_project_grants", index: "by_team", field: "team_id", parentKey: "_id" },
    { table: "workspace_share_grants", index: "by_team", field: "granted_to_team_id", parentKey: "_id" },
    { table: "session_share_grants", index: "by_team", field: "granted_to_team_id", parentKey: "_id" },
  ],
}

const ORG_CONNECTION_CASCADE: ParentCascade = {
  table: "workgraph_connection_metadata",
  index: "by_organization_connection",
  field: "organization_id",
  children: [
    // Carries no tenant column of its own; its only scoping is the connection.
    { table: "workgraph_webhook_deliveries", index: "by_delivery", field: "connection_id", parentKey: "connection_id" },
  ],
}

/** Every table the cascade purges, flattened — the auditable enumeration. */
export const ORG_PURGED_TABLES: readonly string[] = [
  ...ORG_DIRECT_TABLES.map((plan) => plan.table),
  ...ORG_CLERK_TABLES.map((plan) => plan.table),
  ...ORG_WORKSPACE_DOC_TABLES.map((plan) => plan.table),
  ...ORG_WORKSPACE_PUBLIC_TABLES.map((plan) => plan.table),
  ...[
    ORG_SESSION_CASCADE,
    ORG_PRIVATE_SESSION_CASCADE,
    ORG_PROJECT_CASCADE,
    ORG_TEAM_CASCADE,
    ORG_CONNECTION_CASCADE,
  ].flatMap((cascade) => [
    cascade.table,
    ...cascade.children.map((child) => child.table),
  ]),
  "workspaces",
]

/**
 * Tables the cascade deliberately does NOT purge. Enumerated as data, not
 * prose, because `convex-org-deletion-policy.test.ts` asserts that this list
 * plus everything the cascade touches accounts for EVERY table in the schema —
 * so a new table cannot be added without someone deciding which side it is on.
 */
export const ORG_RETAINED_TABLES: Readonly<Record<string, string>> = {
  // Not org-owned: a user belongs to many orgs and always owns a personal one.
  // Deleting users here would destroy other orgs' data. User erasure is a
  // different subject (`user.deleted`) with a different scope.
  users: "user-owned, not org-owned",
  channel_identities: "keyed on the user, with no org linkage",
  // Machine-wide remote access, keyed on the USER and their laptop. There is no
  // org column to scope a purge by, and purging would unenroll a multi-org
  // user's machine because one of their orgs was deleted — taking away their
  // personal work along with the tenant's.
  //
  // Retaining one is not retained authority over the deleted tenant. An
  // enrollment proves "this machine belongs to this user"; every workspace the
  // resulting session can reach is re-resolved through `workspace_memberships`
  // and org grants per request, and the cascade destroys those.
  host_enrollments: "user-owned machine identity, not org-owned",
  // Short-lived is a claim about the SWEEP, not about the predicate: rows are
  // retired by `hostEnrollments.sweepExpired` (crons, every 15 minutes). Before
  // that cron existed this line described an `expires_at` nothing acted on, and
  // the table grew forever.
  host_enrollment_requests: "one-use nonces for the above; user-owned, swept by hostEnrollments.sweepExpired",
  // Same class as `users` above, and the reasoning matters because these rows
  // ARE live credentials — the usual argument for purging.
  //
  // They are not org credentials. A CLI session token is minted at
  // `/api/auth/cli/exchange` before any workspace or org exists; it names a
  // `token_identifier` and nothing else, and the table has no org column to
  // scope a purge by. It authenticates the HUMAN, so purging on org deletion
  // would sign a multi-org user out of every OTHER org's CLI as well.
  //
  // Nor does one survive as authority over the deleted tenant. The token proves
  // identity only: every org-scoped read and write re-resolves the caller's
  // role through `org_memberships` / workspace grants on each request, and the
  // cascade destroys those. So a retained token can still say who you are and
  // can no longer reach anything belonging to the purged org.
  //
  // Retention is bounded without this cascade: each row carries the login
  // chain's absolute expiry (90 days, un-extendable by rotation) and the hourly
  // `cliSessionTokens.reapExpired` cron deletes it after that. User erasure is
  // the correct scope for these, exactly as for `users`.
  cli_session_tokens: "user-owned, not org-owned; identity only, self-expiring and reaped on a cron",
  // Opaque idempotency keys with no tenant column and no tenant index. Scoping
  // them would mean guessing at key structure, and a wrong predicate on a
  // destructive sweep is worse than the residue.
  wake_receipts: "no tenant column or index; scoping would require guessing",
  // Hash-only by construction (`owner_subject_hash`, `operation_hash`) and
  // deliberately retained so a repeated owner deletion replays exactly. Holds
  // no identity to erase.
  workgraph_owner_deletion_receipts: "hashes only, retained for replay",
  // Org is AMBIGUOUS by construction here — `candidate_organization_ids` is a
  // list and `reason` may literally be "ambiguous_organization". Deleting on a
  // candidate match would destroy rows that may belong to another tenant,
  // which is the exact wrong-predicate failure this cascade must not have.
  workgraph_tenancy_migration_quarantine: "organization is ambiguous by construction",
  // W6.3: DEPLOYMENT-wide, single-row Clerk mirror health plus the sweep's
  // round-robin cursor. Holds no tenant identity at all — the cursor is a
  // Clerk org id used as an index position, and everything else is a timestamp
  // about this deployment's webhook channel. Purging it on any one org's
  // deletion would reset another tenant's sweep progress.
  clerk_sync_state: "deployment-wide webhook health and sweep cursor; not org-owned",
  // W4.2: `cache_key` is an OPAQUE caller-scoped string (a JSON array for session
  // operations, a `polar-webhook:` delivery id for webhook dedup) and the table
  // carries no tenant column — deliberately, because it must dedupe
  // unauthenticated webhook deliveries that have no tenant at dedup time. Same
  // class as `wake_receipts`: scoping a destructive sweep here would mean parsing
  // key structure, and a wrong predicate is worse than the residue. Bounded
  // without this cascade — every row carries `expires_at` and the sweep collects
  // it by `by_state_expiry`.
  control_idempotency: "opaque untenanted cache keys; self-expiring via expires_at",
  // In-flight OAuth/device connect attempts. `owner` is present only for the
  // PERSONAL scope and is an opaque caller-resolved key, not an org id — a
  // hosted team attempt carries no tenant column at all, so scoping a
  // destructive sweep here would mean parsing owner-key structure, the same
  // wrong-predicate hazard as `control_idempotency` above. Bounded without this
  // cascade: every row carries `expires_at` (10 min pending, 5 min retention)
  // and `connectionAttempts.sweepExpired` collects it hourly. Nothing survives
  // as authority over the purged org — the resulting connection rows and their
  // credentials ARE reaped, by `ORG_CONNECTION_CASCADE`.
  connection_attempts: "short-lived, untenanted connect handshakes; self-expiring and reaped on a cron",
  // Service installation state is keyed by deployment identity, not by an org
  // or workspace. One deployment can serve many organizations, so deleting it
  // for one tenant would disable shared infrastructure. Neither table contains
  // user identity or grants authority over tenant data.
  service_installations: "deployment-wide service topology; not org-owned",
  service_installation_audit: "deployment-wide service lifecycle audit; not org-owned",
  // W4.4: infrastructure mutual exclusion, one row per cron LANE (a logical name
  // like "workgraph_reconcile"), never per tenant. `holder` is an
  // isolate/invocation identity. Purging a lane's lease because some org was
  // deleted would hand a live lease to a second isolate mid-body, which is the
  // overlap the fence exists to prevent. Self-healing via `lease_expires_at`.
  cron_leases: "per-cron-lane infrastructure lease; no tenant identity, takeover-bounded",
  // This cascade's own bookkeeping.
  org_deletion_receipts: "the purge receipt itself; hashes only",
  org_deletion_barriers: "transient fence, removed by finalize/release",
  orgs: "deleted by finalize once every owned row is gone",
}

function orgDeletionBarrier(ctx: any, orgId: unknown) {
  return ctx.db
    .query("org_deletion_barriers")
    .withIndex("by_org", (query: any) => query.eq("org_id", orgId))
    .unique()
}

function orgDeletionReceipt(ctx: any, orgKeyHash: string, operationHash: string) {
  return ctx.db
    .query("org_deletion_receipts")
    .withIndex("by_org_operation", (query: any) =>
      query.eq("org_key_hash", orgKeyHash).eq("operation_hash", operationHash),
    )
    .unique()
}

function orgKey(org: any) {
  return sha256Hex(`${String(org._id)} ${String(org.clerk_org_id)}`)
}

function orgScope(org: any) {
  return sha256Hex(`${String(org._id)} ${String(org.clerk_org_id)} ${String(org.purge_requested_at)}`)
}

/**
 * The four standing preconditions on the ORG itself, checked identically by
 * prepare and finalize. Re-checked on every finalize rather than trusted from
 * prepare: a purge runs across many transactions, and an org that stops being
 * purgeable partway through must stop being purged.
 */
function orgPurgeRefusal(org: any, confirmClerkOrgId: string) {
  if (!org) return "org_not_found" as const
  const clerkOrgId = typeof org.clerk_org_id === "string" ? org.clerk_org_id : ""
  if (!clerkOrgId) return "not_a_clerk_org" as const
  if (clerkOrgId !== confirmClerkOrgId) return "confirmation_mismatch" as const
  if (typeof org.deleted_at !== "number") return "org_not_deleted" as const
  if (typeof org.purge_requested_at !== "number") return "purge_not_requested" as const
  return undefined
}

/**
 * Refuses while anything is still holding real resources for this org.
 *
 * - A LIVE lease (`acquiring`/`ready`, interval still open) means a sandbox is
 *   running or coming up. Deleting its lease row would make the driver-side
 *   sweep reclaim a VM mid-flight; the D13 reaper marks abandoned leases
 *   `stopped` within its grace period, so this precondition resolves itself
 *   without anyone intervening.
 * - A live per-owner WorkGraph deletion barrier means another destructive
 *   operation is mid-flight over a subset of these same rows. Two cascades
 *   interleaving over one tenant is exactly the situation barriers exist to
 *   prevent.
 */
async function isOrgQuiescent(ctx: any, org: any, now: number) {
  const barriers = await ctx.db
    .query("workgraph_owner_deletion_barriers")
    .withIndex("by_tenant", (query: any) => query.eq("organization_id", org._id))
    .collect()
  if (barriers.some((barrier: any) => barrier.lease_expires_at > now)) return false
  const workspaces = await ctx.db
    .query("workspaces")
    .withIndex("by_org", (query: any) => query.eq("org_id", org._id))
    .collect()
  for (const workspace of workspaces) {
    if (typeof workspace.workspace_id !== "string") continue
    const leases = await ctx.db
      .query("runtime_leases")
      .withIndex("by_workspace_id", (query: any) => query.eq("workspace_id", workspace.workspace_id))
      .collect()
    if (leases.some(isLiveLease)) return false
  }
  return true
}

type BatchState = { remaining: number; deleted: number }

async function drainScoped(ctx: any, plan: ScopedRows, value: unknown, state: BatchState) {
  if (value === undefined || value === null) return true
  if (state.remaining === 0) return false
  const candidates = await ctx.db
    .query(plan.table)
    .withIndex(plan.index, (query: any) => query.eq(plan.field, value))
    .take(state.remaining + 1)
  const rows = candidates.slice(0, state.remaining)
  for (const row of rows) await ctx.db.delete(row._id)
  state.deleted += rows.length
  state.remaining -= rows.length
  return candidates.length === rows.length
}

async function drainAll(ctx: any, plans: readonly ScopedRows[], value: unknown, state: BatchState) {
  for (const plan of plans) {
    if (!(await drainScoped(ctx, plan, value, state))) return false
  }
  return true
}

/**
 * Delete parent rows one at a time, each only after its own children are gone.
 *
 * Take-ONE rather than "collect the parents, then drain them" on purpose: a
 * bounded batch must never depend on an unbounded read, and a loop that always
 * removes the parent it just drained is guaranteed to make progress across
 * resumptions instead of re-deriving the same stuck head forever.
 */
async function drainCascade(ctx: any, plan: ParentCascade, value: unknown, state: BatchState) {
  for (;;) {
    if (state.remaining === 0) return false
    const [parent] = await ctx.db
      .query(plan.table)
      .withIndex(plan.index, (query: any) => query.eq(plan.field, value))
      .take(1)
    if (!parent) return true
    for (const child of plan.children) {
      if (!(await drainScoped(ctx, child, parent[child.parentKey], state))) return false
    }
    if (state.remaining === 0) return false
    await ctx.db.delete(parent._id)
    state.deleted += 1
    state.remaining -= 1
  }
}

async function drainWorkspaces(ctx: any, orgId: unknown, state: BatchState) {
  for (;;) {
    if (state.remaining === 0) return false
    const [workspace] = await ctx.db
      .query("workspaces")
      .withIndex("by_org", (query: any) => query.eq("org_id", orgId))
      .take(1)
    if (!workspace) return true
    // Sessions carry their own children, so they cascade before the flat lists.
    if (!(await drainCascade(ctx, ORG_SESSION_CASCADE, workspace._id, state))) return false
    if (!(await drainCascade(ctx, ORG_PRIVATE_SESSION_CASCADE, workspace._id, state))) return false
    if (!(await drainAll(ctx, ORG_WORKSPACE_DOC_TABLES, workspace._id, state))) return false
    if (!(await drainAll(ctx, ORG_WORKSPACE_PUBLIC_TABLES, workspace.workspace_id, state))) return false
    if (state.remaining === 0) return false
    await ctx.db.delete(workspace._id)
    state.deleted += 1
    state.remaining -= 1
  }
}

/**
 * One bounded, resumable pass. Strictly ordered children-before-parents, and it
 * stops the moment the budget runs out — which is what guarantees a group is
 * fully drained before the next group (and therefore before any parent whose
 * children that group holds) is touched at all.
 */
export async function deleteOrgRecordBatch(ctx: any, org: any, budget: number) {
  const state: BatchState = { remaining: Math.max(1, Math.floor(budget)), deleted: 0 }
  const drain = async () => {
    if (!(await drainWorkspaces(ctx, org._id, state))) return false
    if (!(await drainCascade(ctx, ORG_PROJECT_CASCADE, org._id, state))) return false
    if (!(await drainCascade(ctx, ORG_TEAM_CASCADE, org._id, state))) return false
    if (!(await drainCascade(ctx, ORG_CONNECTION_CASCADE, org._id, state))) return false
    if (!(await drainAll(ctx, ORG_CLERK_TABLES, org.clerk_org_id, state))) return false
    return await drainAll(ctx, ORG_DIRECT_TABLES, org._id, state)
  }
  // `complete` is resolved BEFORE the object is built: an object literal
  // evaluates its properties in order, so `{ deleted: state.deleted, complete:
  // await drain() }` would snapshot the counter at zero and report every batch
  // as having deleted nothing.
  const complete = await drain()
  return { deleted: state.deleted, complete }
}

export async function prepareOrgDeletion(
  ctx: any,
  orgId: unknown,
  confirmClerkOrgId: string,
  operationId: string,
  now: number,
) {
  const org = await ctx.db.get(orgId)
  const refusal = orgPurgeRefusal(org, confirmClerkOrgId)
  if (refusal) return { ok: false as const, reason: refusal }
  const orgKeyHash = await orgKey(org)
  const operationHash = await sha256Hex(operationId)
  const scopeHash = await orgScope(org)
  const receipt = await orgDeletionReceipt(ctx, orgKeyHash, operationHash)
  if (receipt?.state === "completed") {
    return { ok: true as const, state: "completed" as const, scopeHash, result: receipt.result }
  }
  const barrier = await orgDeletionBarrier(ctx, orgId)
  if (barrier?.operation_hash === operationHash && receipt) {
    await renewOrgLease(ctx, barrier, receipt, now)
    return { ok: true as const, state: "deleting" as const, scopeHash: receipt.scope_hash as string }
  }
  if (barrier) {
    // Someone else's operation. Only an EXPIRED lease may be taken over — that
    // is the whole point of the lease, and stealing a live one would run two
    // cascades over one tenant.
    if (barrier.lease_expires_at > now) return { ok: true as const, state: "in_progress" as const, scopeHash }
    await ctx.db.delete(barrier._id)
  }
  if (!(await isOrgQuiescent(ctx, org, now))) return { ok: false as const, reason: "not_quiescent" as const }
  await ctx.db.insert("org_deletion_barriers", {
    org_id: orgId,
    operation_hash: operationHash,
    lease_expires_at: now + orgDeletionLeaseMs,
    created_at: now,
    updated_at: now,
  })
  const next = {
    org_key_hash: orgKeyHash,
    operation_hash: operationHash,
    state: "deleting" as const,
    scope_hash: scopeHash,
    deleted_record_count: receipt?.deleted_record_count ?? 0,
    lease_expires_at: now + orgDeletionLeaseMs,
    updated_at: now,
  }
  if (receipt) await ctx.db.patch(receipt._id, next)
  else await ctx.db.insert("org_deletion_receipts", { ...next, created_at: now })
  return { ok: true as const, state: "acquired" as const, scopeHash }
}

export async function finalizeOrgDeletion(
  ctx: any,
  orgId: unknown,
  confirmClerkOrgId: string,
  operationId: string,
  scopeHash: string,
  now: number,
) {
  const org = await ctx.db.get(orgId)
  const operationHash = await sha256Hex(operationId)
  if (!org) return { ok: false as const, reason: "org_not_found" as const }
  const receipt = await orgDeletionReceipt(ctx, await orgKey(org), operationHash)
  if (receipt?.state === "completed") return { ok: true as const, result: receipt.result }
  const refusal = orgPurgeRefusal(org, confirmClerkOrgId)
  if (refusal) return { ok: false as const, reason: refusal }
  const barrier = await orgDeletionBarrier(ctx, orgId)
  if (
    !receipt ||
    receipt.state !== "deleting" ||
    receipt.scope_hash !== scopeHash ||
    barrier?.operation_hash !== operationHash ||
    receipt.lease_expires_at <= now ||
    barrier.lease_expires_at <= now
  ) {
    return { ok: false as const, reason: "in_progress" as const }
  }
  // Re-checked every batch, not just at prepare: a sandbox that comes back up
  // mid-purge must halt it.
  if (!(await isOrgQuiescent(ctx, org, now))) return { ok: false as const, reason: "not_quiescent" as const }

  const batch = await deleteOrgRecordBatch(ctx, org, ORG_DELETION_BATCH_SIZE)
  const recordCount = (receipt.deleted_record_count ?? 0) + batch.deleted
  if (!batch.complete) {
    await ctx.db.patch(barrier._id, { lease_expires_at: now + orgDeletionLeaseMs, updated_at: now })
    await ctx.db.patch(receipt._id, {
      deleted_record_count: recordCount,
      lease_expires_at: now + orgDeletionLeaseMs,
      updated_at: now,
    })
    return { ok: true as const, state: "deleting" as const, scopeHash }
  }
  // Every owned row is gone; the org row itself goes last so that a purge
  // interrupted at any earlier point is still resumable from it.
  await ctx.db.delete(org._id)
  const result = { deleted: true as const, recordCount: recordCount + 1, completedAt: now }
  await ctx.db.delete(barrier._id)
  await ctx.db.patch(receipt._id, {
    state: "completed",
    deleted_record_count: undefined,
    result,
    lease_expires_at: 0,
    updated_at: now,
  })
  return { ok: true as const, result }
}

export async function renewOrgDeletion(ctx: any, orgId: unknown, operationId: string, scopeHash: string, now: number) {
  const org = await ctx.db.get(orgId)
  if (!org) return { ok: false as const, reason: "org_not_found" as const }
  const operationHash = await sha256Hex(operationId)
  const receipt = await orgDeletionReceipt(ctx, await orgKey(org), operationHash)
  const barrier = await orgDeletionBarrier(ctx, orgId)
  if (
    receipt?.state !== "deleting" ||
    receipt.scope_hash !== scopeHash ||
    barrier?.operation_hash !== operationHash ||
    receipt.lease_expires_at <= now ||
    barrier.lease_expires_at <= now
  ) {
    return { ok: false as const, reason: "in_progress" as const }
  }
  await renewOrgLease(ctx, barrier, receipt, now)
  return { ok: true as const, state: "renewed" as const }
}

export async function releaseOrgDeletion(ctx: any, orgId: unknown, operationId: string) {
  const org = await ctx.db.get(orgId)
  if (!org) return { ok: true as const }
  const operationHash = await sha256Hex(operationId)
  const receipt = await orgDeletionReceipt(ctx, await orgKey(org), operationHash)
  const barrier = await orgDeletionBarrier(ctx, orgId)
  // Only an unfinished operation is releasable; a completed receipt is the
  // durable record and is never withdrawn.
  if (receipt?.state === "deleting") {
    if (barrier?.operation_hash === operationHash) await ctx.db.delete(barrier._id)
    await ctx.db.delete(receipt._id)
  }
  return { ok: true as const }
}

async function renewOrgLease(ctx: any, barrier: any, receipt: any, now: number) {
  await ctx.db.patch(barrier._id, { lease_expires_at: now + orgDeletionLeaseMs, updated_at: now })
  await ctx.db.patch(receipt._id, { lease_expires_at: now + orgDeletionLeaseMs, updated_at: now })
}

/**
 * Operator/Worker-driven purge. Service-token gated because there is no
 * end-user who may authorize the destruction of an org's entire footprint —
 * the org's admins are exactly the people whose access `deleted_at` just
 * revoked.
 */
export const prepareDeletionForService = serviceMutation({
  args: {
    org_id: v.id("orgs"),
    confirm_clerk_org_id: v.string(),
    operation_id: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) =>
    prepareOrgDeletion(ctx, args.org_id, args.confirm_clerk_org_id, args.operation_id, args.now),
})

export const finalizeDeletionForService = serviceMutation({
  args: {
    org_id: v.id("orgs"),
    confirm_clerk_org_id: v.string(),
    operation_id: v.string(),
    scope_hash: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) =>
    finalizeOrgDeletion(ctx, args.org_id, args.confirm_clerk_org_id, args.operation_id, args.scope_hash, args.now),
})

export const renewDeletionForService = serviceMutation({
  args: {
    org_id: v.id("orgs"),
    operation_id: v.string(),
    scope_hash: v.string(),
    renew_only: v.literal(true),
    now: v.number(),
  },
  handler: async (ctx, args) => renewOrgDeletion(ctx, args.org_id, args.operation_id, args.scope_hash, args.now),
})

export const releaseDeletionForService = serviceMutation({
  args: {
    org_id: v.id("orgs"),
    operation_id: v.string(),
  },
  handler: async (ctx, args) => releaseOrgDeletion(ctx, args.org_id, args.operation_id),
})

/**
 * The retention driver (convex/crons.ts). Internal visibility — not callable by
 * any client at all, only the Convex scheduler.
 *
 * Handles ONE org per tick, deliberately: a cascade is destructive, and a bug
 * that escapes its scoping should be able to damage one tenant before the next
 * tick, not every deleted tenant in one transaction. The oldest request goes
 * first so the queue cannot starve.
 *
 * The operation id is DERIVED (`org_purge:<doc id>:<purge_requested_at>`)
 * rather than random, which is what makes ticks resume one another instead of
 * each starting a fresh operation that trips over the previous barrier. It also
 * ties the operation to the specific request: a restore-then-delete produces a
 * new `purge_requested_at`, hence a new operation and a new receipt.
 */
export const purgeDeletedOrgs = cronMutation({
  args: {
    retain_ms: v.number(),
    batch_limit: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now()
    const cutoff = now - args.retain_ms
    // W5: the queue is an index RANGE, not a table scan with a JS filter.
    //
    // `by_purge_requested_at` is ordered, so `(undefined, cutoff]` is exactly
    // "purge requested, and the retention window has elapsed" — and the index
    // returns it already sorted oldest-first, which is the starvation-free
    // order this handler previously produced with a JS `.sort()`. The lower
    // bound is what excludes the (vast majority) of orgs that carry no
    // `purge_requested_at` at all: a missing field sorts BELOW every number in
    // Convex's ordering, so without `.gt(…, undefined)` an `lte` range would
    // match every live org in the deployment.
    //
    // `.take()` rather than `.collect()`: the read-set must stay bounded by a
    // constant, not by however deep the purge queue happens to be. It only
    // caps the REPORTED `due` count — the handler purges one org per tick
    // regardless, and the oldest is always inside the window.
    const due = (
      await ctx.db
        .query("orgs")
        .withIndex("by_purge_requested_at", (q: any) =>
          q.gt("purge_requested_at", undefined).lte("purge_requested_at", cutoff),
        )
        .take(ORG_PURGE_QUEUE_SCAN_LIMIT)
    ).filter(
      (org: any) =>
        typeof org.deleted_at === "number" && typeof org.clerk_org_id === "string" && org.clerk_org_id.length > 0,
    )
    const org = due[0]
    if (!org) return { due: 0, state: "idle" as string, deleted: 0 }

    const operationId = `org_purge:${String(org._id)}:${org.purge_requested_at}`
    const prepared = await prepareOrgDeletion(ctx, org._id, org.clerk_org_id as string, operationId, now)
    if (!prepared.ok) return { due: due.length, state: prepared.reason as string, deleted: 0 }
    if (prepared.state !== "acquired" && prepared.state !== "deleting") {
      return { due: due.length, state: prepared.state as string, deleted: 0 }
    }

    let deleted = 0
    // Several batches per tick: the service-path budget of 8 exists for a tight
    // external driver loop, and at one tick an hour it would take years. Each
    // batch is still individually bounded and individually resumable, so an
    // interrupted tick costs at most one batch of progress.
    const batches = Math.max(1, Math.floor((args.batch_limit ?? 256) / ORG_DELETION_BATCH_SIZE))
    for (let index = 0; index < batches; index += 1) {
      const finalized = await finalizeOrgDeletion(
        ctx,
        org._id,
        org.clerk_org_id as string,
        operationId,
        prepared.scopeHash,
        now,
      )
      if (!finalized.ok) return { due: due.length, state: finalized.reason as string, deleted }
      if ("result" in finalized) {
        return { due: due.length, state: "completed" as string, deleted: finalized.result?.recordCount ?? deleted }
      }
      deleted += ORG_DELETION_BATCH_SIZE
    }
    return { due: due.length, state: "deleting" as string, deleted }
  },
})
