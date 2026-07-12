/**
 * B1/D5/D6 — Polar billing mirror, the SINGLE WRITER of org billing fields
 * (launch plan docs/plans/2026-07-11-012-feat-cloud-subscription-launch-plan.md
 * D5/D6, invariants I-3/I-4; ADR docs/plans/2026-07-11-014-wp-billing-polar-
 * subscription-design.md §3/§4 + addendum).
 *
 * SINGLE-WRITER RULE (I-3): `applyPolarState` below is the ONLY function that
 * ever writes the mirrored billing fields (`plan`, `polar_customer_id`,
 * `polar_subscription_id`, `seats_licensed`, `subscription_status`,
 * `current_period_end`, `billing_synced_at`, `polar_state_modified_at`,
 * `billing_reconcile_flagged_at`). Support overrides go through a distinct
 * audited field, never these (ADR §6 "split-writer temptation"). Enforced
 * grep-style by packages/claxedo-server/src/billing/billing-architecture.test.ts.
 *
 * Convex holds NO Polar credentials — the Worker fetches Polar and calls the
 * service mutations here (same posture as the D13 reaper: driver credentials
 * never enter Convex).
 */
import { v } from "convex/values"
import { authedMutation, cronMutation, serviceMutation, serviceQuery, orgByClerkOrgId, upsertUser } from "./model"

// Free tier is the ABSENCE of a subscription (ADR 014 §5): plan "free" with no
// subscription id / seats / period. subscription_status keeps the last
// reported status so support can see WHY an org is free ("canceled" vs never
// subscribed).
const FREE_STATE = {
  plan: "free" as const,
  subscription_status: undefined as string | undefined,
  polar_subscription_id: undefined as string | undefined,
  seats_licensed: undefined as number | undefined,
  current_period_end: undefined as number | undefined,
  preserve_seats: false,
}

type OrgBillingState = {
  plan: "free" | "pro"
  subscription_status?: string
  polar_subscription_id?: string
  seats_licensed?: number
  current_period_end?: number
  /**
   * SDK 0.48.1 `customer.state_changed` subscription entries carry no
   * seats/quantity field, so a full-state apply would otherwise wipe
   * `seats_licensed`. When true, an absent seats value keeps the existing
   * mirror value. S2-PENDING: verify against the Polar sandbox whether the
   * customer-state payload grows a seats field; pre-decided fallback (ADR 014
   * §4) is the seats feature count via `subscription.*` events + the
   * reconciliation fetch of the full subscription, which is what this flag
   * implements.
   */
  preserve_seats?: boolean
}

const orgStateValidator = v.object({
  // Convex org document id (string form) carried on subscription
  // metadata.org_id since checkout stamps it. Optional: a customer-state
  // payload may include subscriptions we cannot attribute.
  org_id: v.optional(v.string()),
  state: v.object({
    plan: v.union(v.literal("free"), v.literal("pro")),
    subscription_status: v.optional(v.string()),
    polar_subscription_id: v.optional(v.string()),
    seats_licensed: v.optional(v.number()),
    current_period_end: v.optional(v.number()),
    preserve_seats: v.optional(v.boolean()),
  }),
})

function orgDocById(ctx: any, orgId: string) {
  // normalizeId rejects strings that are not ids in the orgs table (a garbage
  // metadata.org_id must resolve to "unknown org", not throw). Test fakes may
  // not implement it; they pass document ids straight through.
  const normalized = typeof ctx.db.normalizeId === "function" ? ctx.db.normalizeId("orgs", orgId) : orgId
  return normalized ? ctx.db.get(normalized) : Promise.resolve(null)
}

async function orgsByPolarCustomerId(ctx: any, polarCustomerId: string) {
  return await ctx.db
    .query("orgs")
    .withIndex("by_polar_customer_id", (q: any) => q.eq("polar_customer_id", polarCustomerId))
    .collect()
}

/**
 * D5 state application, per org. Guards:
 * - source-timestamp last-write-wins: an older replay never overwrites a
 *   newer write (duplicates/reordering are harmless without an event ledger);
 * - past_due carve-out: SDK 0.48.1 customer-state payloads enumerate only
 *   active/trialing subscriptions, so a state_changed arriving DURING dunning
 *   would read as "no subscription" and skip the OQ-4 grace window. A
 *   customer-state/reconciliation source therefore never downgrades a
 *   past_due mirror — the explicit `subscription.canceled/revoked/unpaid`
 *   events (which carry the terminal status) do. S2-PENDING: if the sandbox
 *   shows past_due subscriptions DO appear in customer state, delete the
 *   carve-out.
 */
async function applyStateToOrg(ctx: any, org: any, input: {
  polar_customer_id: string
  source_ts: number
  source: "customer_state" | "subscription_event" | "reconciliation"
  state: OrgBillingState
}) {
  if (org.polar_state_modified_at !== undefined && input.source_ts <= org.polar_state_modified_at) {
    // The reconciliation sweep re-sends Polar's EXISTING modified_at, so an
    // unchanged subscription always lands here. Subscription state is
    // untouched (correctly — nothing changed), but the "we successfully
    // checked" bookkeeping must still advance, or the org stays permanently
    // reconcile-flagged and is re-fetched every sweep forever (F6).
    if (input.source === "reconciliation") {
      const now = Date.now()
      await ctx.db.patch(org._id, {
        billing_synced_at: now,
        billing_reconcile_flagged_at: undefined,
        updated_at: now,
      })
      return { applied: false, reason: "stale_source_reconcile_confirmed" }
    }
    return { applied: false, reason: "stale_source" }
  }
  const now = Date.now()
  const state = input.state
  const downgradeFromFullState = input.source !== "subscription_event" && state.plan === "free"
  if (downgradeFromFullState && org.subscription_status === "past_due") {
    await ctx.db.patch(org._id, {
      billing_synced_at: now,
      billing_reconcile_flagged_at: undefined,
      updated_at: now,
    })
    return { applied: false, reason: "past_due_grace_preserved" }
  }
  const seats = state.plan === "pro" && state.preserve_seats && state.seats_licensed === undefined
    ? org.seats_licensed
    : state.seats_licensed
  await ctx.db.patch(org._id, {
    plan: state.plan,
    polar_customer_id: input.polar_customer_id,
    polar_subscription_id: state.polar_subscription_id,
    seats_licensed: seats,
    subscription_status: state.subscription_status,
    current_period_end: state.current_period_end,
    billing_synced_at: now,
    polar_state_modified_at: input.source_ts,
    billing_reconcile_flagged_at: undefined,
    updated_at: now,
  })
  return { applied: true }
}

/**
 * D5 single writer. Full-state application keyed on `customer.state_changed`
 * (plus `subscription.*` triggers and the reconciliation sweep, which reuse
 * the same routine — ADR 014 §3). For full-state sources, orgs previously
 * mirrored to this Polar customer but ABSENT from `org_states` lost their
 * subscription and are downgraded to free (subject to the guards above);
 * `subscription.*` events are single-subscription triggers and never touch
 * sibling orgs.
 */
export const applyPolarState = serviceMutation({
  args: {
    polar_customer_id: v.string(),
    /** Polar-side source timestamp (ms) of the payload this state came from. */
    source_ts: v.number(),
    source: v.union(v.literal("customer_state"), v.literal("subscription_event"), v.literal("reconciliation")),
    org_states: v.array(orgStateValidator),
  },
  handler: async (ctx, args) => {
    const results: Array<{ org_id: string; applied: boolean; reason?: string }> = []
    const unresolved: string[] = []
    const seen = new Set<string>()

    for (const entry of args.org_states) {
      const org = entry.org_id ? await orgDocById(ctx, entry.org_id) : null
      if (!org) {
        if (entry.org_id) unresolved.push(entry.org_id)
        continue
      }
      seen.add(String(org._id))
      const result = await applyStateToOrg(ctx, org, {
        polar_customer_id: args.polar_customer_id,
        source_ts: args.source_ts,
        source: args.source,
        state: entry.state,
      })
      results.push({ org_id: String(org._id), ...result })
    }

    // Full-state semantics: previously-mirrored orgs absent from the payload
    // lost their subscription in THIS fresh state → free (never on a
    // single-subscription trigger).
    if (args.source !== "subscription_event") {
      for (const org of await orgsByPolarCustomerId(ctx, args.polar_customer_id)) {
        if (seen.has(String(org._id))) continue
        const result = await applyStateToOrg(ctx, org, {
          polar_customer_id: args.polar_customer_id,
          source_ts: args.source_ts,
          source: args.source,
          state: { ...FREE_STATE, subscription_status: "none" },
        })
        results.push({ org_id: String(org._id), ...result })
      }
    }

    return { results, unresolved }
  },
})

/**
 * D6/B4 entitlement read model: the mirrored org fields, by Convex org id or
 * Clerk org id. Returns `found: false` (= free tier, fail-closed I-4) for
 * unknown orgs. The DECISION (grace window, capability mapping) lives in
 * packages/claxedo-server/src/billing/entitlement.ts — this is a dumb read.
 */
export const entitlementState = serviceQuery({
  args: {
    org_id: v.optional(v.string()),
    clerk_org_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const org = args.org_id
      ? await orgDocById(ctx, args.org_id)
      : args.clerk_org_id
        ? await orgByClerkOrgId(ctx.db, args.clerk_org_id)
        : null
    if (!org || org.deleted_at) return { found: false as const }
    return {
      found: true as const,
      org_id: String(org._id),
      plan: org.plan,
      subscription_status: org.subscription_status,
      seats_licensed: org.seats_licensed,
      current_period_end: org.current_period_end,
      billing_synced_at: org.billing_synced_at,
      polar_state_modified_at: org.polar_state_modified_at,
    }
  },
})

// Personal-org resolution, duplicated on purpose from orgs.personalOrgForUser /
// workspaces.ensureOwnerOrg (house precedent — those two are already copies of
// each other). Importing from ./orgs here would create an orgs↔billing import
// cycle, since orgs.ts calls enforceSeatCapacity below.
async function ensurePersonalOrg(ctx: any, user: { _id: unknown; name?: string; email?: string }) {
  const existing = (await ctx.db
    .query("orgs")
    .withIndex("by_owner", (q: any) => q.eq("owner_user_id", user._id))
    .collect())
    .find((org: any) => org.kind === "personal" && !org.clerk_org_id && !org.deleted_at)
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

async function orgMemberCount(ctx: any, orgId: unknown) {
  const memberships = await ctx.db
    .query("org_memberships")
    .withIndex("by_org_user", (q: any) => q.eq("org_id", orgId))
    .collect()
  return memberships.length
}

/**
 * Checkout/portal context for the Worker billing routes: the caller's active
 * org (Clerk org claim if a member, else the personal org — mirrors
 * orgs.resolveForMe), their role in it, and the seat facts the checkout needs.
 * Role gating (admin/owner) is the ROUTE's job; this only reports.
 */
export const checkoutContext = authedMutation({
  args: {
    clerk_org_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await upsertUser(ctx)
    const clerkOrg = args.clerk_org_id ? await orgByClerkOrgId(ctx.db, args.clerk_org_id) : undefined
    let org = clerkOrg && !clerkOrg.deleted_at ? clerkOrg : undefined
    let role: string | undefined
    if (org) {
      const membership = (await ctx.db
        .query("org_memberships")
        .withIndex("by_org_user", (q: any) => q.eq("org_id", org._id))
        .collect())
        .find((item: any) => item.user_id === user._id)
      if (!membership) org = undefined
      else role = membership.role
    }
    if (!org) {
      org = await ensurePersonalOrg(ctx, user)
      role = "owner"
    }
    return {
      org_id: String(org._id),
      clerk_org_id: org.clerk_org_id,
      role,
      member_count: await orgMemberCount(ctx, org._id),
      plan: org.plan,
      subscription_status: org.subscription_status,
      seats_licensed: org.seats_licensed,
      polar_customer_id: org.polar_customer_id,
    }
  },
})

/**
 * D6 seat enforcement helper — hard-block, no soft-allow (ADR 014 §4). Called
 * by every org-membership INSERT path for non-personal-owner members. Rules:
 * - personal-org owner membership is always allowed (the auto-created org of
 *   1 must never be blockable);
 * - no `seats_licensed` on the org = nothing licensed to exceed: free orgs
 *   accept members (free tier is identity + local workspaces; hosted
 *   capabilities are separately entitlement-gated), matching the launch
 *   rehearsal order signup → org → INVITE → subscribe;
 * - with a license, adding beyond `seats_licensed` throws the typed
 *   `seat_limit_reached` error — the app shows the inline seat-purchase step.
 */
export async function enforceSeatCapacity(ctx: any, org: any, newMemberUserId: unknown) {
  if (!org) return
  if (org.kind === "personal" && org.owner_user_id === newMemberUserId) return
  if (org.seats_licensed === undefined) return
  const current = await orgMemberCount(ctx, org._id)
  if (current >= org.seats_licensed) {
    throw new Error(
      `seat_limit_reached: org has ${current} of ${org.seats_licensed} licensed seats; add a seat before adding a member`,
    )
  }
}

/**
 * D5 reconciliation sweep, Convex half: FLAG orgs whose mirror is stale
 * (webhook endpoint may be silently disabled — Polar kills endpoints after 10
 * consecutive failed deliveries). The Worker half (worker.ts `scheduled` →
 * src/billing/reconcile.ts) fetches fresh customer state from Polar for
 * flagged orgs and re-applies via applyPolarState, which clears the flag.
 * Convex never talks to Polar. Full scan: the orgs table is small at launch;
 * revisit with an index if it ever isn't.
 */
export const flagStaleBillingSync = cronMutation({
  args: {
    stale_after_ms: v.number(),
  },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - args.stale_after_ms
    let flagged = 0
    for (const org of await ctx.db.query("orgs").collect()) {
      if (!org.polar_customer_id || org.deleted_at) continue
      if (org.billing_reconcile_flagged_at !== undefined) continue
      if (org.billing_synced_at !== undefined && org.billing_synced_at >= cutoff) continue
      await ctx.db.patch(org._id, { billing_reconcile_flagged_at: Date.now() })
      flagged += 1
    }
    return { flagged }
  },
})

/** Orgs flagged for reconciliation, for the Worker sweep. */
export const listReconcileFlagged = serviceQuery({
  args: {},
  handler: async (ctx) => {
    const orgs = await ctx.db.query("orgs").collect()
    return orgs
      .filter((org: any) => org.billing_reconcile_flagged_at !== undefined && org.polar_customer_id && !org.deleted_at)
      .map((org: any) => ({
        org_id: String(org._id),
        polar_customer_id: org.polar_customer_id as string,
      }))
  },
})
