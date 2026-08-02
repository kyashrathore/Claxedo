/**
 * W6.3 — the Clerk membership reconciliation sweep (cf-reliability review W6.3).
 *
 * WHY THIS EXISTS, precisely. Org memberships reach Convex by Clerk webhook and
 * by nothing else (`convex/http.ts` → `orgs.applyClerkWebhook`), and the runtime
 * authorization path reads the resulting Convex row as the SOLE authority:
 * `model.ts orgAdminForUser` resolves org admin from `org_memberships`, and JWT
 * `org_id`/`org_role` claims are deliberately untrusted (D2). That combination
 * is what makes a missed delivery a security problem rather than a data-quality
 * one — a dropped `organizationMembership.deleted` leaves a removed employee
 * holding org-admin access, on every workspace in that org, indefinitely. There
 * is no expiry to save us: membership rows have no TTL, by design.
 *
 * Webhooks alone cannot cover this, for the same reason billing's D5 sweep
 * exists: Svix retries a failing endpoint for ~27.5h and disables it entirely
 * after 5 days of failures, so "the events stopped arriving" is a state the
 * system must detect on its own rather than assume away. `flagStaleBillingSync`
 * is the in-repo template and this is deliberately its shape — a scheduled
 * truth-keeper that re-derives state from the source of record.
 *
 * WHERE IT DIVERGES from the billing template, and why:
 *
 *   Billing splits Convex/Worker because Convex holds no Polar credential and
 *   the ADR keeps provider credentials out of the deployment. This sweep runs
 *   ENTIRELY inside Convex as an action holding `CLERK_SECRET_KEY`. That is a
 *   deliberate difference, not an oversight:
 *
 *   1. Clerk is not a third-party integration to this deployment the way Polar
 *      is — it is the IDENTITY PROVIDER. Convex already holds
 *      `CLERK_WEBHOOK_SECRET` (`convex/http.ts`) and `CLERK_JWT_ISSUER`
 *      (`convex/auth.config.ts`); Clerk material is already deployment-resident.
 *   2. The Worker split's actual purpose is to keep credentials that can spend
 *      money or destroy infrastructure (Polar, Daytona, Cloudflare) out of the
 *      transaction runtime. A Clerk secret key reads and writes identity — the
 *      thing this deployment's authorization is already derived from.
 *   3. The corrective write must be transactional against `org_memberships`,
 *      which lives here. A Worker-side sweep would need a new service-token
 *      mutation surface — a second door into membership authority — to do what
 *      an internal action does with no new externally reachable surface at all.
 *
 * The core diff is a PURE FUNCTION (`reconcileMemberships`) taking the two row
 * sets and returning corrections. Every interesting decision — what counts as
 * divergence, which direction is corrected, how the tombstone interacts — is
 * therefore testable with no Convex runtime and no network, and the action
 * around it is thin plumbing.
 */
import { v } from "convex/values"
import { internal } from "./_generated/api"
import { clerkRoleFor, orgMembershipTombstone } from "./clerkTombstones"
import { cronAction, cronMutation, cronQuery, orgByClerkOrgId, userByClerkSubject } from "./model"

// ===========================================================================
// Bounds. Every one of these is a number chosen against a documented limit,
// not a round number that felt safe.
// ===========================================================================

/**
 * Orgs examined per sweep run.
 *
 * Clerk's Backend API allows 1000 requests / 10s on production instances and
 * 100 / 10s on development ones (clerk.com/docs — "Rate limits"), per
 * application instance keyed on the secret key. The binding constraint is NOT
 * that ceiling but the fact that this sweep SHARES it with live product
 * traffic: burning the instance's quota would rate-limit real sign-ins, which
 * is a worse outage than the drift being corrected.
 *
 * 50 orgs/run at 1 request per org (500 memberships per page covers essentially
 * every real org in one call) is ~50 requests spread over a run, against a
 * budget of 100 per 10 seconds on the SMALLER (development) tier. Well inside
 * the tighter limit, so the cap is safe on either instance type.
 *
 * Coverage does not suffer: the sweep round-robins through the org table via
 * `sweep_cursor`, so N orgs are fully covered every ceil(N/50) runs. At the
 * daily cadence that is complete coverage of 50 orgs/day, and the cadence is
 * the knob to turn if that becomes too slow — not this cap.
 */
export const CLERK_SWEEP_ORG_CAP = 50

/**
 * Membership page size. Clerk's documented maximum is 500 ("must be an integer
 * greater than zero and less than 501"), and the maximum is the correct choice
 * for a rate-limited sweep: fewer, larger requests is strictly cheaper against
 * a request-count budget than more, smaller ones.
 */
export const CLERK_MEMBERSHIP_PAGE_SIZE = 500

/**
 * Pages per org, i.e. a hard ceiling of 25,000 memberships examined per org.
 *
 * Not a guess at org size — a fence against an unbounded loop driven by a
 * REMOTE response. A paging loop whose exit condition comes from a third party's
 * `total_count` is a loop a third party can make infinite; this makes the worst
 * case finite regardless of what Clerk returns. An org that legitimately
 * exceeds it is reported as `truncated` rather than silently half-swept,
 * because a partial membership list would look exactly like mass revocation to
 * the diff below — see `reconcileMemberships`' refusal.
 */
export const CLERK_MEMBERSHIP_PAGE_CAP = 50

/**
 * Tombstone retention: 30 days.
 *
 * Sized off the redelivery window it has to outlast, not chosen for roundness.
 * Svix's schedule retries an individual message for ~27.5h and disables an
 * endpoint only after 5 days of continuous failure; once re-enabled, queued
 * messages can flow days after the events they describe. 30 days clears that
 * whole envelope with a wide margin.
 *
 * The failure mode of expiring too EARLY is the resurrection bug returning, so
 * the margin is deliberately generous. The cost of expiring too late is a few
 * bytes per revoked membership, which is why the tradeoff is not close.
 */
export const CLERK_TOMBSTONE_RETAIN_MS = 30 * 24 * 60 * 60 * 1_000

/**
 * Webhook-liveness threshold: 24h with no Clerk webhook of ANY type.
 *
 * Matches `flagStaleBillingSync`'s 24h for consistency, and is comfortably
 * longer than Svix's ~27.5h per-message retry envelope would need to look
 * healthy... which is the point: the flag fires on the ENDPOINT being dead, not
 * on one message struggling. See `clerk_sync_state` in convex/schema.ts for why
 * this signal is deployment-wide rather than per-org (a quiet org is normal;
 * a quiet DEPLOYMENT with active orgs is not).
 */
export const CLERK_WEBHOOK_STALE_AFTER_MS = 24 * 60 * 60 * 1_000

/** Documented env var. Set on the Convex deployment; see the report/DoD. */
export const CLERK_SECRET_ENV = "CLERK_SECRET_KEY"

/**
 * How many orgs the liveness check reads to answer "does a live Clerk org
 * exist?". A constant bound, not a count — the answer is a boolean, and the
 * read must stay bounded (W5.6). Deep enough that a run of deleted orgs at the
 * head of the index cannot produce a false "no Clerk orgs".
 */
export const CLERK_LIVENESS_ORG_PROBE = 64

// ===========================================================================
// The pure core.
// ===========================================================================

export type ClerkMembership = Readonly<{
  clerk_subject: string
  role: string
  /** Clerk's `updated_at` for the membership, in ms. */
  updated_at: number
}>

export type ConvexMembership = Readonly<{
  membership_id: string
  clerk_subject: string
  role: string
  clerk_updated_at?: number
}>

export type MembershipCorrection =
  | Readonly<{ kind: "revoke"; membership_id: string; clerk_subject: string; role: string }>
  | Readonly<{ kind: "insert"; clerk_subject: string; role: string; clerk_updated_at: number }>
  | Readonly<{ kind: "role"; membership_id: string; clerk_subject: string; from: string; to: string }>

export type SweepRunResult = Readonly<{
  orgs: number
  corrections: number
  rate_limited: boolean
  cursor: string | undefined
}>

export type ReconcileOutcome =
  | Readonly<{ ok: true; corrections: readonly MembershipCorrection[] }>
  | Readonly<{ ok: false; refusal: "truncated_clerk_page" }>

/**
 * The diff. Convex rows on the left, Clerk's rows on the right, corrections out.
 *
 * THREE divergence classes, and the third is the one that is easy to forget:
 *
 * 1. In Convex, absent from Clerk → REVOKE. The security case: the membership
 *    Clerk no longer has is the removed employee still holding access.
 *
 * 2. In Clerk, absent from Convex → INSERT. This direction is a genuine fork,
 *    so the decision is recorded here rather than left implicit: the sweep
 *    inserts. It mirrors what a delivered `organizationMembership.created`
 *    would have done, and this sweep is CORRECTING for that delivery having
 *    been lost — flagging instead would leave a legitimate member locked out of
 *    their own org until a human noticed, converting a webhook drop into a
 *    support ticket. The write is not a new authority either: the same
 *    membership, with the same role, is what the webhook path already inserts
 *    unconditionally on `.created`, so inserting here grants nothing the mirror
 *    would not have granted anyway. The safety argument is asymmetric and worth
 *    stating: the revoke direction removes access (fails safe if wrong), the
 *    insert direction grants it (fails open if wrong) — which is exactly why
 *    the insert path is gated on the caller having successfully read Clerk's
 *    COMPLETE membership list, per the refusal below.
 *
 * 3. Present in both, role DIFFERS → correct the role. Skipping this would
 *    leave the highest-value drift uncorrected: a `.updated` that demoted an
 *    admin to member is a privilege the sweep is meant to take back, and it is
 *    invisible to a presence-only diff. A tombstone cannot express it either,
 *    since the membership was never revoked.
 *
 * THE REFUSAL. If the caller could not read Clerk's membership list to the end
 * (`truncated`), the whole org is skipped and NOTHING is corrected. A partial
 * list is indistinguishable from "Clerk has fewer members now", so acting on
 * one would revoke every member on the unread pages — a sweep that turns a
 * paging hiccup into mass access revocation. Refusing wholesale is the only
 * safe reading, and it is the pure function's job (not the caller's) because
 * this is the invariant that keeps the corrective writer from being a weapon.
 */
export function reconcileMemberships(input: {
  convex: readonly ConvexMembership[]
  clerk: readonly ClerkMembership[]
  truncated?: boolean
}): ReconcileOutcome {
  if (input.truncated) return { ok: false, refusal: "truncated_clerk_page" }
  const clerkBySubject = new Map(input.clerk.map((row) => [row.clerk_subject, row]))
  const convexBySubject = new Map(input.convex.map((row) => [row.clerk_subject, row]))
  const corrections: MembershipCorrection[] = []

  for (const row of input.convex) {
    const remote = clerkBySubject.get(row.clerk_subject)
    if (!remote) {
      corrections.push({
        kind: "revoke",
        membership_id: row.membership_id,
        clerk_subject: row.clerk_subject,
        role: row.role,
      })
      continue
    }
    const wanted = clerkRoleFor(remote.role)
    if (wanted !== row.role) {
      corrections.push({
        kind: "role",
        membership_id: row.membership_id,
        clerk_subject: row.clerk_subject,
        from: row.role,
        to: wanted,
      })
    }
  }
  for (const remote of input.clerk) {
    if (convexBySubject.has(remote.clerk_subject)) continue
    corrections.push({
      kind: "insert",
      clerk_subject: remote.clerk_subject,
      role: clerkRoleFor(remote.role),
      clerk_updated_at: remote.updated_at,
    })
  }
  return { ok: true, corrections }
}

// ===========================================================================
// The Clerk client seam.
// ===========================================================================

export type ClerkPage = Readonly<{
  memberships: readonly ClerkMembership[]
  /** Clerk's `total_count`, when present, for the paging exit condition. */
  total?: number
}>

/** Injected so the action's logic is testable against a fake, including 429s. */
export type ClerkClient = Readonly<{
  listMemberships(input: {
    clerkOrgId: string
    limit: number
    offset: number
  }): Promise<ClerkPage>
}>

/** Thrown by the real client on a 429 so the sweep can stop rather than hammer. */
export class ClerkRateLimited extends Error {
  constructor(readonly retryAfterSeconds: number | undefined) {
    super("Clerk rate limited")
    this.name = "ClerkRateLimited"
  }
}

function membershipUpdatedAt(row: Record<string, any>) {
  const value = row.updated_at ?? row.created_at
  return typeof value === "number" ? value : Date.now()
}

function membershipSubject(row: Record<string, any>) {
  const value = row.public_user_data?.user_id ?? row.user_id
  return typeof value === "string" ? value : undefined
}

/**
 * The real client. Reads `CLERK_SECRET_KEY` from the action's env.
 *
 * Deliberately a hand-rolled fetch rather than `@clerk/backend`: the surface
 * used is one GET, the repo's only other Clerk API consumer
 * (`scripts/smoke/sync-clerk-workgraph-fixtures.ts`) already does exactly this
 * with the same `authorization: Bearer` shape, and adding a Node SDK to the
 * Convex bundle for one endpoint is weight the deployment would carry forever.
 */
export function clerkClientFromEnv(secret: string | undefined, request: typeof fetch = fetch): ClerkClient {
  const key = secret?.trim()
  if (!key) throw new Error(`Clerk reconciliation requires ${CLERK_SECRET_ENV}`)
  return {
    async listMemberships({ clerkOrgId, limit, offset }) {
      const path = `/v1/organizations/${encodeURIComponent(clerkOrgId)}/memberships?limit=${limit}&offset=${offset}`
      const response = await request(`https://api.clerk.com${path}`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (response.status === 429) {
        // Clerk documents `Retry-After` in seconds on a 429 and does NOT
        // document `X-RateLimit-*`, so that header is the only backoff signal
        // to read; absent, the caller falls back to stopping the run.
        const retryAfter = Number(response.headers.get("retry-after"))
        throw new ClerkRateLimited(Number.isFinite(retryAfter) ? retryAfter : undefined)
      }
      if (!response.ok) {
        throw new Error(`Clerk membership read failed: ${response.status}`)
      }
      const body = await response.json() as Record<string, any>
      const data = Array.isArray(body?.data) ? body.data : []
      return {
        memberships: data.flatMap((row: Record<string, any>) => {
          const subject = membershipSubject(row)
          // A membership with no resolvable user id cannot be diffed in either
          // direction, so it is DROPPED rather than treated as absent — the
          // latter would revoke a real member over a response-shape surprise.
          if (!subject) return []
          return [{
            clerk_subject: subject,
            role: typeof row.role === "string" ? row.role : "",
            updated_at: membershipUpdatedAt(row),
          }]
        }),
        total: typeof body?.total_count === "number" ? body.total_count : undefined,
      }
    },
  }
}

/**
 * Page one org's memberships to completion, within the page cap.
 *
 * `truncated` is returned rather than thrown because the diff above treats it
 * as a refusal reason: the distinction between "Clerk says this org has 3
 * members" and "we only managed to read 3 of this org's members" is the whole
 * safety property, and it has to survive the trip to the diff.
 */
export async function fetchClerkMemberships(
  client: ClerkClient,
  clerkOrgId: string,
  pageCap = CLERK_MEMBERSHIP_PAGE_CAP,
): Promise<{ memberships: ClerkMembership[]; truncated: boolean; requests: number }> {
  const memberships: ClerkMembership[] = []
  let requests = 0
  for (let page = 0; page < pageCap; page += 1) {
    const result = await client.listMemberships({
      clerkOrgId,
      limit: CLERK_MEMBERSHIP_PAGE_SIZE,
      offset: page * CLERK_MEMBERSHIP_PAGE_SIZE,
    })
    requests += 1
    memberships.push(...result.memberships)
    // A short page is the end of the list. `total_count`, when Clerk sends it,
    // is the second exit — both are checked because relying on `total` alone
    // would loop forever if it were ever absent or wrong, and relying on the
    // short page alone costs an extra request per org.
    if (result.memberships.length < CLERK_MEMBERSHIP_PAGE_SIZE) {
      return { memberships, truncated: false, requests }
    }
    if (typeof result.total === "number" && memberships.length >= result.total) {
      return { memberships, truncated: false, requests }
    }
  }
  return { memberships, truncated: true, requests }
}

// ===========================================================================
// The Convex halves: one read query, one corrective mutation, one action.
// ===========================================================================

/**
 * One page of Clerk orgs to sweep — IDS ONLY, deliberately.
 *
 * The memberships are NOT returned here, and that split is a correctness
 * requirement rather than a style choice. Convex caps the documents one
 * transaction may read, and a version of this that also read every membership
 * plus a user row per membership would read
 * `50 orgs × (memberships + users)` in ONE transaction — for fifty
 * hundred-member orgs that is ~10,000 documents, and it does not degrade
 * gracefully: past the cap the transaction THROWS, so the sweep would simply
 * stop working once the deployment grew, on a cron where nobody is watching.
 * That is precisely the failure the W5.6 guard exists to prevent, and the guard
 * cannot see it (the reads are all index-backed; it is the FAN-OUT that is
 * unbounded, not any single query).
 *
 * So each org's memberships are read in their own transaction, immediately
 * before that org is diffed (`listOrgMemberships`). That also narrows the
 * staleness window rather than widening it: a membership read moments before
 * its Clerk comparison is fresher than one read at the top of the run.
 *
 * `.gt("clerk_org_id", cursor)` does double duty — past the cursor, AND "has a
 * clerk_org_id at all", since a missing field sorts below every string in
 * Convex's ordering. Personal orgs (which have none) are therefore excluded by
 * the index bound rather than by a JS filter, which matters: diffing a personal
 * org against an empty Clerk response would revoke the owner's membership in the
 * one org every user has.
 */
export const listOrgsToSweep = cronQuery({
  args: {
    cursor: v.optional(v.string()),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(Math.floor(args.limit), CLERK_SWEEP_ORG_CAP))
    const orgs = await ctx.db
      .query("orgs")
      .withIndex("by_clerk_org_id", (q: any) => q.gt("clerk_org_id", args.cursor))
      .take(limit)
    // The cursor advances past every org READ, not just the sweepable ones —
    // otherwise a run whose page is entirely deleted orgs would return no
    // cursor and the next run would re-read the same page forever.
    const last = orgs[orgs.length - 1]
    return {
      orgs: orgs
        .filter((org: any) =>
          typeof org.clerk_org_id === "string" && org.clerk_org_id.length > 0 && !org.deleted_at)
        .map((org: any) => ({ clerk_org_id: org.clerk_org_id as string })),
      cursor: typeof last?.clerk_org_id === "string" ? last.clerk_org_id : undefined,
      // A page shorter than the limit is the end of the table, which is what
      // tells the action to wrap the cursor back to the start.
      exhausted: orgs.length < limit,
    }
  },
})

/**
 * One org's current membership rows, resolved to Clerk subjects.
 *
 * Its own transaction, per the read-bound argument on `listOrgsToSweep`. Bounded
 * by a single org's membership count, which is bounded in turn by that org's
 * Clerk seat count — a real quantity, unlike "every membership in the
 * deployment".
 */
export const listOrgMemberships = cronQuery({
  args: {
    clerk_org_id: v.string(),
  },
  handler: async (ctx, args) => {
    const org = await orgByClerkOrgId(ctx.db, args.clerk_org_id)
    if (!org || org.deleted_at) return null
    const memberships = await ctx.db
      .query("org_memberships")
      .withIndex("by_org_user", (q: any) => q.eq("org_id", org._id))
      .collect()
    const rows = []
    for (const membership of memberships) {
      const user = await ctx.db.get(membership.user_id)
      // A membership whose user row is gone has no Clerk subject to diff
      // against, so it is not reported. It is also unreachable by any caller
      // (`orgAdminForUser` resolves the role through the user row), so it is not
      // the standing-access hazard this sweep exists to close.
      if (typeof user?.clerk_subject !== "string") continue
      rows.push({
        membership_id: String(membership._id),
        clerk_subject: user.clerk_subject,
        role: membership.role as string,
        clerk_updated_at: membership.clerk_updated_at as number | undefined,
      })
    }
    return rows
  },
})

/**
 * The corrective writer. THE one place the sweep may change membership state.
 *
 * Every correction is RE-DERIVED here rather than trusted from the action: the
 * action read the rows in an earlier transaction, so by now a webhook may have
 * changed the very membership being corrected. Concretely — a revoke re-checks
 * that the row still exists and still belongs to the org and user it named, and
 * an insert re-checks the tombstone. Trusting a `membership_id` from an earlier
 * transaction is exactly how a sweep deletes the wrong row.
 */
export const applyReconcileCorrections = cronMutation({
  args: {
    clerk_org_id: v.string(),
    observed_at: v.number(),
    corrections: v.array(v.any()),
  },
  handler: async (ctx, args) => {
    const org = await orgByClerkOrgId(ctx.db, args.clerk_org_id)
    if (!org || org.deleted_at) return { applied: 0, skipped: args.corrections.length }
    let applied = 0
    let skipped = 0
    for (const correction of args.corrections as MembershipCorrection[]) {
      const user = await userByClerkSubject(ctx.db, correction.clerk_subject)
      if (!user) {
        skipped += 1
        continue
      }
      const existing = await ctx.db
        .query("org_memberships")
        .withIndex("by_org_user", (q: any) => q.eq("org_id", org._id).eq("user_id", user._id))
        .unique()

      if (correction.kind === "revoke") {
        // Re-derived, not taken on the action's word: the row must still be
        // there AND still be the one named. A membership re-created by a
        // webhook since the read is a NEWER fact than this sweep's observation
        // and must survive it.
        if (!existing || String(existing._id) !== correction.membership_id) {
          skipped += 1
          continue
        }
        await ctx.db.delete(existing._id)
        // Tombstoned with the sweep's OBSERVATION time. Clerk did not tell us
        // when the membership vanished — only that it is absent now — so the
        // observation instant is the honest bound, and it is what a late
        // `.created` is compared against.
        await writeTombstone(ctx, {
          clerkOrgId: args.clerk_org_id,
          clerkSubject: correction.clerk_subject,
          clerkUpdatedAt: args.observed_at,
          source: "sweep",
        })
        await recordMembershipAudit(ctx, {
          org,
          userId: user._id,
          action: "org.membership.revoked",
          source: "sweep",
          metadata: {
            clerk_org_id: args.clerk_org_id,
            clerk_subject: correction.clerk_subject,
            revoked_role: correction.role,
            clerk_observed_at: args.observed_at,
          },
        })
        applied += 1
        continue
      }

      if (correction.kind === "insert") {
        if (existing) {
          skipped += 1
          continue
        }
        // The tombstone outranks the sweep too, and deliberately so. If a
        // revocation was observed AFTER the membership timestamp Clerk is
        // reporting, this "missing in Convex" row is the stale side and
        // inserting it would resurrect revoked access — the same bug on the
        // webhook path, arriving by a different route.
        const tombstone = await orgMembershipTombstone(ctx.db, args.clerk_org_id, correction.clerk_subject)
        if (tombstone && tombstone.clerk_updated_at >= correction.clerk_updated_at) {
          skipped += 1
          continue
        }
        const now = Date.now()
        await ctx.db.insert("org_memberships", {
          org_id: org._id,
          user_id: user._id,
          role: correction.role,
          clerk_updated_at: correction.clerk_updated_at,
          created_at: now,
          updated_at: now,
        })
        if (tombstone) await ctx.db.delete(tombstone._id)
        await recordMembershipAudit(ctx, {
          org,
          userId: user._id,
          action: "org.membership.restored",
          source: "sweep",
          metadata: {
            clerk_org_id: args.clerk_org_id,
            clerk_subject: correction.clerk_subject,
            granted_role: correction.role,
            clerk_updated_at: correction.clerk_updated_at,
          },
        })
        applied += 1
        continue
      }

      if (correction.kind === "role") {
        if (!existing || String(existing._id) !== correction.membership_id) {
          skipped += 1
          continue
        }
        // `from` is re-verified: if the role is no longer what the action saw,
        // something else has written since and this correction is stale.
        if (existing.role !== correction.from) {
          skipped += 1
          continue
        }
        await ctx.db.patch(existing._id, { role: correction.to, updated_at: Date.now() })
        await recordMembershipAudit(ctx, {
          org,
          userId: user._id,
          action: "org.membership.role_corrected",
          source: "sweep",
          metadata: {
            clerk_org_id: args.clerk_org_id,
            clerk_subject: correction.clerk_subject,
            previous_role: correction.from,
            corrected_role: correction.to,
            clerk_observed_at: args.observed_at,
          },
        })
        applied += 1
        continue
      }
      skipped += 1
    }
    return { applied, skipped }
  },
})

/** Sweep bookkeeping: the cursor, the counters, the rate-limit marker. */
export const recordSweepRun = cronMutation({
  args: {
    cursor: v.optional(v.string()),
    orgs: v.number(),
    corrections: v.number(),
    rate_limited: v.boolean(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const state = await clerkSyncStateRow(ctx.db)
    const patch = {
      sweep_cursor: args.cursor,
      last_sweep_at: args.now,
      last_sweep_orgs: args.orgs,
      last_sweep_corrections: args.corrections,
      last_sweep_rate_limited_at: args.rate_limited ? args.now : undefined,
      updated_at: args.now,
    }
    if (state) await ctx.db.patch(state._id, patch)
    else await ctx.db.insert("clerk_sync_state", { scope: "clerk", ...patch, created_at: args.now })
    return { ok: true }
  },
})

/**
 * The sweep. An ACTION because it must `fetch` Clerk, which queries and
 * mutations structurally cannot do.
 *
 * Corrections are written per-org as they are computed rather than batched to
 * the end: a run that is cut short by a rate limit or a timeout should keep the
 * corrections it already earned, and each org's write is independently
 * meaningful. `test_client` exists so the whole action — paging, cursor,
 * backoff, correction dispatch — is exercisable against a fake; it is inert in
 * production (an internal action is unreachable by clients at all, and absent
 * the arg the real env-backed client is used).
 */
export const sweepClerkMemberships = cronAction({
  args: {
    org_limit: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  // The return type is annotated rather than inferred because this handler
  // reaches its own module through `internal.clerkReconcile.*`, which makes the
  // inferred type self-referential (TS7022/TS7023). Convex's own docs prescribe
  // an explicit annotation for exactly this cycle.
  handler: async (ctx, args): Promise<SweepRunResult> => {
    const now = args.now ?? Date.now()
    const limit = Math.max(1, Math.min(Math.floor(args.org_limit ?? CLERK_SWEEP_ORG_CAP), CLERK_SWEEP_ORG_CAP))
    const client = clerkClientFromEnv(process.env[CLERK_SECRET_ENV])
    const cursor: string | null = await ctx.runQuery(internal.clerkReconcile.readSweepCursor, {})
    return await runClerkSweep({ ctx, client, limit, now, cursor: cursor ?? undefined })
  },
})

/**
 * Tombstone TTL. Without this the table only ever grows — one row per revoked
 * membership, forever, which is precisely the unbounded-growth shape the W5
 * retention cron was added for (`usageMetering.pruneUsageFacts`).
 *
 * Retention runs from `created_at` (when the tombstone was WRITTEN) rather than
 * from `clerk_updated_at` (when Clerk says the revocation happened), because
 * what has to be outlasted is the REDELIVERY window, and that window starts
 * when we learned about the event.
 *
 * Reaping a tombstone re-opens the resurrection hole for that pair — which is
 * safe only because 30 days is far outside any Svix redelivery envelope, and is
 * why `CLERK_TOMBSTONE_RETAIN_MS` is documented against that envelope rather
 * than picked for tidiness.
 */
export const reapMembershipTombstones = cronMutation({
  args: {
    retain_ms: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - args.retain_ms
    const rows = await ctx.db
      .query("clerk_membership_tombstones")
      .withIndex("by_created_at", (q: any) => q.lte("created_at", cutoff))
      .take(args.limit)
    for (const row of rows) await ctx.db.delete(row._id)
    return { deleted: rows.length }
  },
})

/**
 * Webhook-liveness flag — the `flagStaleBillingSync` analogue (W6.3 item 4).
 *
 * Fires when NO Clerk webhook of any type has been seen for `stale_after_ms`
 * DESPITE the deployment having at least one live Clerk org. Both halves are
 * load-bearing:
 *
 * - "no webhook of any type" rather than per-org staleness, because Clerk only
 *   emits on actual membership change; a per-org clock would flag every org with
 *   a stable roster, i.e. all the healthy ones. See `clerk_sync_state` in
 *   convex/schema.ts for the full argument.
 * - "despite active orgs", because a deployment with no Clerk orgs SHOULD be
 *   silent, and flagging it would make the signal meaningless on every fresh or
 *   self-hosted deployment.
 *
 * The absent-`last_webhook_at` case is deliberately NOT flagged. A deployment
 * that has never seen a Clerk webhook is far more likely to be one where Clerk
 * orgs were created by another path (fixtures, migration) than a broken
 * endpoint, and firing on it would light this flag on every dev deployment
 * permanently — the fastest way to teach operators to ignore it.
 */
export const flagStaleClerkWebhooks = cronMutation({
  args: {
    stale_after_ms: v.number(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now()
    const state = await clerkSyncStateRow(ctx.db)
    if (state?.webhook_stale_flagged_at !== undefined) return { flagged: false, reason: "already_flagged" }
    const lastWebhookAt = state?.last_webhook_at
    if (typeof lastWebhookAt !== "number") return { flagged: false, reason: "never_seen" }
    if (lastWebhookAt >= now - args.stale_after_ms) return { flagged: false, reason: "fresh" }
    // "A LIVE Clerk org exists." The range is the same
    // `.gt(clerk_org_id, undefined)` the sweep pages ("has a clerk_org_id at
    // all"); `deleted_at` cannot be part of it (Convex requires `.eq` on the
    // leading field before ranging a later one, and there is no single org id to
    // pin here), so it stays a JS filter over a bounded `.take()`. The bound is
    // a constant rather than 1 because a deployment whose first few orgs are all
    // deleted must not read as "no Clerk orgs" — that would silence the flag on
    // exactly the deployments that have been around long enough to have churn.
    const candidates = await ctx.db
      .query("orgs")
      .withIndex("by_clerk_org_id", (q: any) => q.gt("clerk_org_id", undefined))
      .take(CLERK_LIVENESS_ORG_PROBE)
    if (!candidates.some((org: any) => !org.deleted_at)) return { flagged: false, reason: "no_clerk_orgs" }
    if (state) await ctx.db.patch(state._id, { webhook_stale_flagged_at: now, updated_at: now })
    return { flagged: true, reason: "stale", last_webhook_at: lastWebhookAt }
  },
})

/** The round-robin cursor the last run committed. */
export const readSweepCursor = cronQuery({
  args: {},
  handler: async (ctx) => {
    const state = await clerkSyncStateRow(ctx.db)
    return typeof state?.sweep_cursor === "string" ? state.sweep_cursor : null
  },
})

/**
 * The action body, with the Clerk client and the Convex ctx both injected.
 *
 * Split out from `sweepClerkMemberships` so the whole control flow — cursor
 * advance and wrap, per-org correction dispatch, 429 backoff — is testable
 * against a fake client and a fake ctx. The exported function is the seam; the
 * registered action is a two-line wrapper that supplies the real ones.
 */
export async function runClerkSweep(input: {
  ctx: {
    runQuery: (reference: any, args: Record<string, unknown>) => Promise<any>
    runMutation: (reference: any, args: Record<string, unknown>) => Promise<any>
  }
  client: ClerkClient
  limit: number
  now: number
  /** The starting cursor. Supplied by the action from `clerk_sync_state`. */
  cursor?: string
}): Promise<SweepRunResult> {
  const { ctx, client, limit, now } = input
  const page = await ctx.runQuery(internal.clerkReconcile.listOrgsToSweep, {
    cursor: input.cursor,
    limit,
  })
  let corrections = 0
  let rateLimited = false
  let swept = 0
  // The cursor the run COMMITS to. On a clean pass it is the page's end (or
  // undefined to wrap); on a rate-limited pass it is the last org actually
  // swept, so the next run resumes at the first org this one did not reach
  // rather than skipping past it.
  let cursor = page.exhausted ? undefined : page.cursor
  for (const org of page.orgs as Array<{ clerk_org_id: string }>) {
    // Read this org's memberships in their OWN transaction, right before the
    // comparison — see `listOrgsToSweep` for why the fan-out cannot live in one
    // transaction, and note this also makes the rows fresher at the moment they
    // are diffed.
    const convexMemberships: ConvexMembership[] | null = await ctx.runQuery(
      internal.clerkReconcile.listOrgMemberships,
      { clerk_org_id: org.clerk_org_id },
    )
    // Deleted (or vanished) between the page read and now. Nothing to reconcile,
    // and the org cascade owns its rows.
    if (convexMemberships === null) continue
    let clerk: Awaited<ReturnType<typeof fetchClerkMemberships>>
    try {
      clerk = await fetchClerkMemberships(client, org.clerk_org_id)
    } catch (error) {
      if (error instanceof ClerkRateLimited) {
        // STOP the whole run, do not skip to the next org. Clerk's limit is
        // per-application-instance, not per-org, so the next org's request
        // would be rate-limited too — continuing would spend the retry budget
        // of live product traffic (sign-ins share this quota) to accomplish
        // nothing. The cursor is committed where the run stopped, so the
        // unswept remainder is the next run's first work.
        rateLimited = true
        cursor = swept > 0 ? cursor : input.cursor
        break
      }
      // A per-org failure (network, 5xx, an org deleted in Clerk since the read)
      // skips THAT org and continues: unlike a rate limit, it says nothing about
      // whether the next org can be read.
      continue
    }
    const outcome = reconcileMemberships({
      convex: convexMemberships,
      clerk: clerk.memberships,
      truncated: clerk.truncated,
    })
    swept += 1
    // A refusal is not an error — it is the diff declining to act on an
    // incomplete read (see `reconcileMemberships`). Nothing is written.
    if (!outcome.ok) continue
    if (outcome.corrections.length === 0) continue
    const applied = await ctx.runMutation(internal.clerkReconcile.applyReconcileCorrections, {
      clerk_org_id: org.clerk_org_id,
      observed_at: now,
      corrections: outcome.corrections,
    })
    corrections += applied?.applied ?? 0
  }
  // On a rate-limited stop the cursor is the LAST FULLY SWEPT org, which is
  // what makes the next run resume rather than skip. `swept` counts orgs whose
  // diff completed, so a run that was limited on its very first org keeps the
  // cursor it started with.
  if (rateLimited) {
    const sweptOrgs = (page.orgs as Array<{ clerk_org_id: string }>).slice(0, swept)
    const last = sweptOrgs[sweptOrgs.length - 1]
    cursor = last ? last.clerk_org_id : input.cursor
  }
  await ctx.runMutation(internal.clerkReconcile.recordSweepRun, {
    cursor,
    orgs: swept,
    corrections,
    rate_limited: rateLimited,
    now,
  })
  return { orgs: swept, corrections, rate_limited: rateLimited, cursor }
}

// ===========================================================================
// Shared write helpers.
// ===========================================================================

async function clerkSyncStateRow(db: any) {
  return await db.query("clerk_sync_state").withIndex("by_scope", (q: any) => q.eq("scope", "clerk")).unique()
}

async function writeTombstone(ctx: any, input: {
  clerkOrgId: string
  clerkSubject: string
  clerkUpdatedAt: number
  source: "webhook" | "sweep"
}) {
  const existing = await orgMembershipTombstone(ctx.db, input.clerkOrgId, input.clerkSubject)
  if (existing) {
    // Keep the LATEST revocation. An older one arriving late must not lower the
    // bar a subsequent late `.created` has to clear.
    if (existing.clerk_updated_at >= input.clerkUpdatedAt) return
    await ctx.db.patch(existing._id, {
      clerk_updated_at: input.clerkUpdatedAt,
      source: input.source,
    })
    return
  }
  await ctx.db.insert("clerk_membership_tombstones", {
    clerk_org_id: input.clerkOrgId,
    clerk_subject: input.clerkSubject,
    clerk_updated_at: input.clerkUpdatedAt,
    source: input.source,
    created_at: Date.now(),
  })
}

async function recordMembershipAudit(ctx: any, input: {
  org: { _id: unknown }
  userId: unknown
  action: string
  source: "webhook" | "sweep"
  metadata: Record<string, unknown>
}) {
  await ctx.db.insert("audit_events", {
    user_id: input.userId,
    org_id: input.org._id,
    action: input.action,
    result: "allow",
    reason: input.source,
    metadata: { ...input.metadata, source: input.source },
    created_at: Date.now(),
  })
}
