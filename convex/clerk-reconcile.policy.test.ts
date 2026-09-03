import { describe, expect, test } from "vitest"
import { convexTest } from "convex-test"
import { internal } from "./_generated/api"
import schema from "./schema"
import {
  CLERK_LIVENESS_ORG_PROBE,
  CLERK_MEMBERSHIP_PAGE_SIZE,
  CLERK_SWEEP_ORG_CAP,
  CLERK_TOMBSTONE_RETAIN_MS,
  ClerkRateLimited,
  fetchClerkMemberships,
  reconcileMemberships,
  runClerkSweep,
  type ClerkClient,
  type ClerkMembership,
} from "./clerkReconcile"

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob("./**/*.ts")

/**
 * Every table here requires `created_at`/`updated_at`, EXCEPT
 * `clerk_membership_tombstones` (no `updated_at`) and `audit_events` (no
 * `updated_at`) — see their seeds below, which spell those out by hand rather
 * than using `stamped()`.
 */
const stamped = <T extends Record<string, unknown>>(row: T) => ({ created_at: 1, updated_at: 1, ...row })

/**
 * W6.3 — Clerk membership drift (cf-reliability review W6.3).
 *
 * WHY THESE TESTS ARE SECURITY TESTS, not data-consistency tests. Org
 * memberships reach Convex by Clerk webhook and by nothing else, and
 * `model.ts orgAdminForUser` reads the resulting row as the SOLE authority — JWT
 * org claims are deliberately untrusted (D2). So each divergence below is a
 * specific person holding specific access they should not have, with no expiry
 * to end it. `org_memberships` has no TTL by design.
 *
 * These run through the real function pipeline via `convex-test` — the
 * `webhookMutation`/`cronMutation`/`cronQuery` wrappers from `model.ts`, the
 * real `by_clerk_org_id`/`by_org_user`/`by_membership`/`by_scope` indexes, and
 * real `.unique()` semantics. The previous version of this suite drove a
 * hand-written `db` double (with a bespoke index-range builder,
 * `convex-index-harness.ts`) and reached past the builders into `_handler`, so
 * it never exercised any of that — including the internal-visibility guard
 * that is the actual point of `webhookMutation`/`cronMutation` (see
 * `model.ts`'s comment on why `applyClerkWebhook` must not be public).
 *
 * `runClerkSweep` (the action body, exported separately from the registered
 * `sweepClerkMemberships` action so it is testable against an injected Clerk
 * client) is exercised here against `t.query`/`t.mutation` for its
 * `ctx.runQuery`/`ctx.runMutation` calls — i.e. the SAME real `listOrgsToSweep`
 * / `listOrgMemberships` / `applyReconcileCorrections` / `recordSweepRun`
 * internal functions the production action calls, just invoked directly
 * instead of through a registered `internalAction`. convex-test has no cron
 * support, so the scheduled functions are always called directly like this
 * rather than relying on a cron trigger.
 *
 * Every assertion here was run against pre-fix code first and shown to FAIL;
 * the failure output is recorded in the W6.3 report. A green test nobody has
 * seen red is a claim, not a control.
 */

// ---------------------------------------------------------------------------
// Fixture + ctx helpers.
// ---------------------------------------------------------------------------

/**
 * An org + a user + (by default) one membership between them — the shape every
 * divergence test starts from. `role`/`clerkUpdatedAt` seed the membership row;
 * `skipMembership` leaves the user unattached, for the "membership exists only
 * in Clerk" / "no row yet" cases.
 */
async function seedOrgFixture(
  t: ReturnType<typeof convexTest>,
  opts: { role?: "admin" | "member"; clerkUpdatedAt?: number; skipMembership?: boolean } = {},
) {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", stamped({ clerk_org_id: "clerk_org_1", kind: "clerk", name: "Acme" }) as never)
    const userId = await ctx.db.insert("users", stamped({ clerk_subject: "clerk_user_1", token_identifier: "clerk:clerk_user_1" }) as never)
    let membershipId: unknown
    if (!opts.skipMembership) {
      membershipId = await ctx.db.insert("org_memberships", stamped({
        org_id: orgId,
        user_id: userId,
        role: opts.role ?? "admin",
        clerk_updated_at: opts.clerkUpdatedAt,
      }) as never)
    }
    return { orgId, userId, membershipId }
  })
}

async function seedManyOrgs(t: ReturnType<typeof convexTest>, count: number) {
  await t.run(async (ctx) => {
    for (let index = 0; index < count; index++) {
      await ctx.db.insert("orgs", stamped({
        // Zero-padded so string order matches numeric order — the cursor is a
        // position in the `by_clerk_org_id` index, which orders lexically.
        clerk_org_id: `clerk_org_${String(index).padStart(3, "0")}`,
        kind: "clerk",
        name: `Org ${index}`,
      }) as never)
    }
  })
}

async function membershipRows(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ctx.db.query("org_memberships").collect())
}

async function tombstoneRows(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ctx.db.query("clerk_membership_tombstones").collect())
}

async function auditRows(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ctx.db.query("audit_events").collect())
}

/**
 * Adapts `t.query`/`t.mutation` to the `{ runQuery, runMutation }` shape
 * `runClerkSweep` expects from an action ctx — the real internal functions,
 * called the same way the registered `sweepClerkMemberships` action calls them.
 */
function sweepCtx(t: ReturnType<typeof convexTest>) {
  return {
    runQuery: (reference: any, args: Record<string, unknown>) => t.query(reference, args),
    runMutation: (reference: any, args: Record<string, unknown>) => t.mutation(reference, args),
  }
}

/** A fake Clerk returning one fixed roster per org, with a request counter. */
function fakeClerk(
  memberships: Record<string, ClerkMembership[]>,
  options: { failWith?: (clerkOrgId: string, requests: number) => unknown } = {},
) {
  const requests: Array<{ clerkOrgId: string; offset: number; limit: number }> = []
  const client: ClerkClient = {
    async listMemberships({ clerkOrgId, limit, offset }) {
      requests.push({ clerkOrgId, offset, limit })
      const failure = options.failWith?.(clerkOrgId, requests.length)
      if (failure) throw failure
      const all = memberships[clerkOrgId] ?? []
      return { memberships: all.slice(offset, offset + limit), total: all.length }
    },
  }
  return { client, requests }
}

const WEBHOOK_SEEN = { scope: "clerk" as const, created_at: 1, updated_at: 1 }

// ===========================================================================
// The pure diff. No Convex runtime involved at all.
// ===========================================================================

describe("reconcileMemberships — the pure diff (W6.3)", () => {
  test("a membership present in Convex and absent from Clerk is revoked", () => {
    // THE security case. A dropped `organizationMembership.deleted` leaves a
    // removed employee holding org-admin on every workspace in the org.
    const outcome = reconcileMemberships({
      convex: [{ membership_id: "membership_1", clerk_subject: "clerk_user_1", role: "admin" }],
      clerk: [],
    })
    expect(outcome).toEqual({
      ok: true,
      corrections: [{ kind: "revoke", membership_id: "membership_1", clerk_subject: "clerk_user_1", role: "admin" }],
    })
  })

  test("a membership present in Clerk and absent from Convex is INSERTED, not merely flagged", () => {
    // The documented direction decision. Inserting mirrors what the dropped
    // `.created` would have done; flagging would lock a legitimate member out
    // of their own org until a human noticed.
    const outcome = reconcileMemberships({
      convex: [],
      clerk: [{ clerk_subject: "clerk_user_1", role: "org:member", updated_at: 5_000 }],
    })
    expect(outcome).toEqual({
      ok: true,
      corrections: [{ kind: "insert", clerk_subject: "clerk_user_1", role: "member", clerk_updated_at: 5_000 }],
    })
  })

  test("a role that drifted is corrected in both directions", () => {
    // Invisible to a presence-only diff, and the highest-value drift there is:
    // a dropped `.updated` that demoted an admin leaves the admin bit set.
    const demoted = reconcileMemberships({
      convex: [{ membership_id: "membership_1", clerk_subject: "clerk_user_1", role: "admin" }],
      clerk: [{ clerk_subject: "clerk_user_1", role: "org:member", updated_at: 5_000 }],
    })
    expect(demoted).toEqual({
      ok: true,
      corrections: [{ kind: "role", membership_id: "membership_1", clerk_subject: "clerk_user_1", from: "admin", to: "member" }],
    })
    const promoted = reconcileMemberships({
      convex: [{ membership_id: "membership_1", clerk_subject: "clerk_user_1", role: "member" }],
      clerk: [{ clerk_subject: "clerk_user_1", role: "org:admin", updated_at: 5_000 }],
    })
    expect(promoted.ok && promoted.corrections[0]).toMatchObject({ kind: "role", from: "member", to: "admin" })
  })

  test("an agreeing pair produces no corrections", () => {
    // The control that stops every test above being satisfiable by a function
    // that always emits a correction.
    const outcome = reconcileMemberships({
      convex: [{ membership_id: "membership_1", clerk_subject: "clerk_user_1", role: "admin" }],
      clerk: [{ clerk_subject: "clerk_user_1", role: "org:admin", updated_at: 5_000 }],
    })
    expect(outcome).toEqual({ ok: true, corrections: [] })
  })

  test("a TRUNCATED Clerk read refuses the whole org rather than revoking everyone", () => {
    // The load-bearing refusal. A partial membership list is indistinguishable
    // from "Clerk has fewer members now", so acting on one would revoke every
    // member on the pages that were never read — a paging hiccup escalated into
    // mass access revocation. Note the roster here is NON-empty and still
    // nothing is emitted: the refusal is on the read being incomplete, not on
    // the result being empty.
    const outcome = reconcileMemberships({
      convex: [
        { membership_id: "membership_1", clerk_subject: "clerk_user_1", role: "admin" },
        { membership_id: "membership_2", clerk_subject: "clerk_user_2", role: "member" },
      ],
      clerk: [{ clerk_subject: "clerk_user_1", role: "org:admin", updated_at: 5_000 }],
      truncated: true,
    })
    expect(outcome).toEqual({ ok: false, refusal: "truncated_clerk_page" })
  })
})

// ===========================================================================
// Divergence correction end-to-end, through the real action + real functions.
// ===========================================================================

describe("the sweep corrects a seeded divergence within one cycle (W6.3 DoD)", () => {
  test("membership in Convex, absent from Clerk: revoked, tombstoned, audited", async () => {
    const t = convexTest(schema, modules)
    const { orgId, userId } = await seedOrgFixture(t)
    const { client } = fakeClerk({ clerk_org_1: [] })

    const result = await runClerkSweep({ ctx: sweepCtx(t), client, limit: 10, now: 9_000 })

    expect(result).toMatchObject({ orgs: 1, corrections: 1, rate_limited: false })
    // The access is actually gone — not merely reported.
    expect(await membershipRows(t)).toEqual([])
    // Tombstoned at the OBSERVATION instant, so a late `.created` older than
    // this sweep loses.
    expect(await tombstoneRows(t)).toEqual([
      expect.objectContaining({
        clerk_org_id: "clerk_org_1",
        clerk_subject: "clerk_user_1",
        clerk_updated_at: 9_000,
        source: "sweep",
      }),
    ])
    // The audit event the DoD names, attributed to the SWEEP so an operator can
    // tell a reconciliation from a webhook.
    expect(await auditRows(t)).toEqual([
      expect.objectContaining({
        action: "org.membership.revoked",
        org_id: orgId,
        user_id: userId,
        metadata: expect.objectContaining({ source: "sweep", revoked_role: "admin" }),
      }),
    ])
  })

  test("reconcile revoke also revokes the member's runtime tokens (dropped-webhook fallback)", async () => {
    const t = convexTest(schema, modules)
    const { orgId, userId } = await seedOrgFixture(t)
    await t.run(async (ctx) => {
      const workspaceId = await ctx.db.insert("workspaces", {
        workspace_id: "ws_1",
        org_id: orgId,
        owner_user_id: userId,
        backing: "cloud-vm",
        access: "cloud",
        display_name: "Reconcile token revocation",
        created_at: 1,
        updated_at: 1,
      })
      await ctx.db.insert("runtime_access_tokens", {
        jti: "jti_1",
        workspace_id: workspaceId,
        minted_for_user_id: userId,
        host_id: "host_1",
        principal_kind: "user",
        actor_id: userId,
        actor_kind: "human",
        role: "owner",
        expires_at: 9_999_999,
        created_at: 1,
      })
    })
    const { client } = fakeClerk({ clerk_org_1: [] })

    await runClerkSweep({ ctx: sweepCtx(t), client, limit: 10, now: 9_000 })

    expect(await membershipRows(t)).toEqual([])
    // Without the revocation wiring the token would stay live to expiry.
    expect(await t.run(async (ctx) =>
      await ctx.db.query("runtime_access_tokens").withIndex("by_jti", (q) => q.eq("jti", "jti_1")).unique()
    )).toMatchObject({ revoked_at: expect.any(Number) })
  })

  test("membership in Clerk, missing in Convex: inserted with an audit event", async () => {
    const t = convexTest(schema, modules)
    const { orgId, userId } = await seedOrgFixture(t, { skipMembership: true })
    const { client } = fakeClerk({
      clerk_org_1: [{ clerk_subject: "clerk_user_1", role: "org:admin", updated_at: 5_000 }],
    })

    const result = await runClerkSweep({ ctx: sweepCtx(t), client, limit: 10, now: 9_000 })

    expect(result).toMatchObject({ orgs: 1, corrections: 1 })
    expect(await membershipRows(t)).toEqual([
      expect.objectContaining({ org_id: orgId, user_id: userId, role: "admin", clerk_updated_at: 5_000 }),
    ])
    expect(await auditRows(t)).toEqual([
      expect.objectContaining({
        action: "org.membership.restored",
        metadata: expect.objectContaining({ source: "sweep", granted_role: "admin" }),
      }),
    ])
  })

  test("a drifted role is corrected and audited", async () => {
    const t = convexTest(schema, modules)
    await seedOrgFixture(t, { role: "admin" })
    const { client } = fakeClerk({
      clerk_org_1: [{ clerk_subject: "clerk_user_1", role: "org:member", updated_at: 5_000 }],
    })

    await runClerkSweep({ ctx: sweepCtx(t), client, limit: 10, now: 9_000 })

    const memberships = await membershipRows(t)
    expect(memberships[0]).toMatchObject({ role: "member" })
    const audit = await auditRows(t)
    expect(audit[0]).toMatchObject({
      action: "org.membership.role_corrected",
      metadata: expect.objectContaining({ previous_role: "admin", corrected_role: "member" }),
    })
  })

  test("an agreeing org is left completely alone", async () => {
    // Guards against the reaper-that-destroys-everything failure: the tests
    // above are all satisfiable by a sweep that revokes unconditionally.
    const t = convexTest(schema, modules)
    await seedOrgFixture(t, { role: "admin" })
    const { client } = fakeClerk({
      clerk_org_1: [{ clerk_subject: "clerk_user_1", role: "org:admin", updated_at: 5_000 }],
    })

    const result = await runClerkSweep({ ctx: sweepCtx(t), client, limit: 10, now: 9_000 })

    expect(result).toMatchObject({ orgs: 1, corrections: 0 })
    expect(await membershipRows(t)).toHaveLength(1)
    expect(await auditRows(t)).toEqual([])
  })

  test("a truncated Clerk read corrects NOTHING for that org", async () => {
    // End-to-end proof of the refusal: the org has two members, Clerk pages
    // forever, and no revocation is written.
    const t = convexTest(schema, modules)
    const { orgId } = await seedOrgFixture(t)
    await t.run(async (ctx) => {
      const userId2 = await ctx.db.insert("users", stamped({ clerk_subject: "clerk_user_2", token_identifier: "clerk:clerk_user_2" }) as never)
      await ctx.db.insert("org_memberships", stamped({ org_id: orgId, user_id: userId2, role: "member" }) as never)
    })
    // A client that always returns a FULL page and understates `total` never
    // satisfies either exit condition, so the pager hits its cap → truncated.
    const client: ClerkClient = {
      async listMemberships({ limit }) {
        return {
          memberships: Array.from({ length: limit }, (_, index) => ({
            clerk_subject: `filler_${index}`,
            role: "org:member",
            updated_at: 5_000,
          })),
          total: undefined,
        }
      },
    }

    const result = await runClerkSweep({ ctx: sweepCtx(t), client, limit: 10, now: 9_000 })

    expect(result).toMatchObject({ corrections: 0 })
    expect(await membershipRows(t)).toHaveLength(2)
    expect(await auditRows(t)).toEqual([])
  })
})

// ===========================================================================
// The tombstone / ordering guard.
// ===========================================================================

describe("ordering guard: a delayed .created must not resurrect a revoked membership (W6.3)", () => {
  const deleteEvent = (updatedAt: number) => ({
    type: "organizationMembership.deleted",
    data: {
      organization: { id: "clerk_org_1" },
      public_user_data: { user_id: "clerk_user_1" },
      updated_at: updatedAt,
    },
  })
  const createEvent = (updatedAt: number) => ({
    type: "organizationMembership.created",
    data: {
      organization: { id: "clerk_org_1", name: "Acme" },
      public_user_data: { user_id: "clerk_user_1" },
      role: "org:admin",
      updated_at: updatedAt,
    },
  })

  test("THE BUG: .deleted then a delayed .created leaves the membership GONE", async () => {
    // The positive control for gap (b). Pre-fix this test failed with the
    // membership array holding one row — the delete removed it and the late
    // create put it straight back, restoring org-admin access Clerk had already
    // revoked. Svix retries a message for ~27.5h and only disables an endpoint
    // after 5 days, so a create arriving after the delete it should have
    // preceded is ordinary webhook behavior.
    const t = convexTest(schema, modules)
    await seedOrgFixture(t, { clerkUpdatedAt: 1_000 })

    await t.mutation(internal.orgs.applyClerkWebhook, deleteEvent(2_000) as never)
    expect(await membershipRows(t)).toEqual([])

    // The redelivery: an OLDER event arriving later.
    await t.mutation(internal.orgs.applyClerkWebhook, createEvent(1_000) as never)

    expect(await membershipRows(t)).toEqual([])
  })

  test("a create bearing the SAME timestamp as the revocation is also dropped", async () => {
    // The `>=` boundary. Clerk timestamps are coarse enough for a delete and a
    // redelivered create to share one, and a `>` comparison would admit it —
    // reopening the hole for exactly the ambiguous case.
    const t = convexTest(schema, modules)
    await seedOrgFixture(t, { clerkUpdatedAt: 1_000 })
    await t.mutation(internal.orgs.applyClerkWebhook, deleteEvent(2_000) as never)
    await t.mutation(internal.orgs.applyClerkWebhook, createEvent(2_000) as never)
    expect(await membershipRows(t)).toEqual([])
  })

  test("a GENUINE later re-join still succeeds and retires the tombstone", async () => {
    // The guard must not become a permanent ban — otherwise removing someone
    // from an org would lock them out of ever rejoining it, which is a worse
    // bug than the one being fixed. This is what makes the guard a timestamp
    // comparison rather than a blocklist.
    const t = convexTest(schema, modules)
    const { orgId, userId } = await seedOrgFixture(t, { clerkUpdatedAt: 1_000 })
    await t.mutation(internal.orgs.applyClerkWebhook, deleteEvent(2_000) as never)

    await t.mutation(internal.orgs.applyClerkWebhook, createEvent(3_000) as never)

    expect(await membershipRows(t)).toEqual([
      expect.objectContaining({ org_id: orgId, user_id: userId, role: "admin", clerk_updated_at: 3_000 }),
    ])
    // Retired, not left behind: a stale tombstone would make the NEXT
    // revoke-then-rejoin cycle compare against the wrong (older) revocation.
    expect(await tombstoneRows(t)).toEqual([])
  })

  test("the delete path tombstones even when the membership row is not there yet", async () => {
    // Svix does not guarantee order, so `.deleted` before `.created` is a real
    // arrival pattern — and it is exactly the one with nothing to delete. A
    // tombstone written only when a row existed would skip it and the following
    // create would win.
    const t = convexTest(schema, modules)
    await seedOrgFixture(t, { skipMembership: true })

    await t.mutation(internal.orgs.applyClerkWebhook, deleteEvent(2_000) as never)
    expect(await tombstoneRows(t)).toHaveLength(1)

    await t.mutation(internal.orgs.applyClerkWebhook, createEvent(1_000) as never)
    expect(await membershipRows(t)).toEqual([])
  })

  test("an out-of-order pair of deletes keeps the NEWEST revocation", async () => {
    // An older `.deleted` arriving late must not lower the bar a subsequent
    // late `.created` has to clear.
    const t = convexTest(schema, modules)
    await seedOrgFixture(t, { clerkUpdatedAt: 1_000 })
    await t.mutation(internal.orgs.applyClerkWebhook, deleteEvent(5_000) as never)
    await t.mutation(internal.orgs.applyClerkWebhook, deleteEvent(2_000) as never)
    const tombstones = await tombstoneRows(t)
    expect(tombstones[0]).toMatchObject({ clerk_updated_at: 5_000 })
    // A create between the two timestamps still loses.
    await t.mutation(internal.orgs.applyClerkWebhook, createEvent(3_000) as never)
    expect(await membershipRows(t)).toEqual([])
  })

  test("the webhook delete path writes an audit event", async () => {
    // The positive control for gap (a): pre-fix `deleteClerkMembership` wrote
    // NO audit record, making the most security-relevant event in the mirror
    // invisible after the fact.
    const t = convexTest(schema, modules)
    const { orgId, userId } = await seedOrgFixture(t, { clerkUpdatedAt: 1_000 })
    await t.mutation(internal.orgs.applyClerkWebhook, deleteEvent(2_000) as never)
    expect(await auditRows(t)).toEqual([
      expect.objectContaining({
        action: "org.membership.revoked",
        org_id: orgId,
        user_id: userId,
        result: "allow",
        metadata: expect.objectContaining({
          source: "webhook",
          revoked_role: "admin",
          clerk_updated_at: 2_000,
        }),
      }),
    ])
  })

  test("the SWEEP's tombstone also blocks a later stale create", async () => {
    // The two writers have to agree: a revocation the sweep discovered must
    // fence the webhook path exactly as a webhook revocation does, or the
    // resurrection bug simply arrives by the other route.
    const t = convexTest(schema, modules)
    await seedOrgFixture(t, { clerkUpdatedAt: 1_000 })
    const { client } = fakeClerk({ clerk_org_1: [] })
    await runClerkSweep({ ctx: sweepCtx(t), client, limit: 10, now: 9_000 })
    expect(await membershipRows(t)).toEqual([])

    await t.mutation(internal.orgs.applyClerkWebhook, createEvent(8_000) as never)

    expect(await membershipRows(t)).toEqual([])
  })

  test("the sweep's INSERT respects a newer tombstone", async () => {
    // The mirror image: Clerk reports a membership the sweep is missing, but a
    // revocation was observed AFTER the timestamp Clerk reports — so Clerk's
    // row is the stale side and inserting it would resurrect revoked access.
    const t = convexTest(schema, modules)
    await seedOrgFixture(t, { skipMembership: true })
    await t.run(async (ctx) => {
      await ctx.db.insert("clerk_membership_tombstones", {
        clerk_org_id: "clerk_org_1",
        clerk_subject: "clerk_user_1",
        clerk_updated_at: 8_000,
        source: "webhook",
        created_at: 8_000,
      } as never)
    })
    const { client } = fakeClerk({
      clerk_org_1: [{ clerk_subject: "clerk_user_1", role: "org:admin", updated_at: 5_000 }],
    })

    const result = await runClerkSweep({ ctx: sweepCtx(t), client, limit: 10, now: 9_000 })

    expect(result).toMatchObject({ corrections: 0 })
    expect(await membershipRows(t)).toEqual([])
  })
})

// ===========================================================================
// Bounds: org cap, coverage, and 429 backoff.
// ===========================================================================

describe("the sweep respects its bounds (W6.3 DoD)", () => {
  test("a run examines at most the org cap, and never more than CLERK_SWEEP_ORG_CAP", async () => {
    const t = convexTest(schema, modules)
    await seedManyOrgs(t, 20)
    const { client, requests } = fakeClerk({})

    const result = await runClerkSweep({ ctx: sweepCtx(t), client, limit: 5, now: 9_000 })

    expect(result.orgs).toBe(5)
    expect(requests).toHaveLength(5)
    // The registered action clamps to the constant too, so an over-large
    // `org_limit` cannot widen the blast radius past the documented budget.
    expect(CLERK_SWEEP_ORG_CAP).toBeLessThanOrEqual(50)
  })

  test("successive runs round-robin through the org table and wrap at the end", async () => {
    // What makes a per-run cap compatible with full coverage. Without the
    // cursor, every run would re-check the same head of the table forever and
    // orgs past the cap would NEVER be swept — the cap would be a coverage bug
    // rather than a rate-limit measure.
    const t = convexTest(schema, modules)
    await seedManyOrgs(t, 7)
    const { client, requests } = fakeClerk({})
    const ctx = sweepCtx(t)

    const first = await runClerkSweep({ ctx, client, limit: 3, now: 1 })
    expect(first.cursor).toBe("clerk_org_002")
    const second = await runClerkSweep({ ctx, client, limit: 3, now: 2, cursor: first.cursor })
    expect(second.cursor).toBe("clerk_org_005")
    const third = await runClerkSweep({ ctx, client, limit: 3, now: 3, cursor: second.cursor })
    // A short page is the end of the table, so the cursor wraps to the start.
    expect(third.cursor).toBeUndefined()

    // Every org examined exactly once across the three runs.
    expect(requests.map((request) => request.clerkOrgId)).toEqual([
      "clerk_org_000", "clerk_org_001", "clerk_org_002",
      "clerk_org_003", "clerk_org_004", "clerk_org_005",
      "clerk_org_006",
    ])
  })

  test("a Clerk 429 STOPS the run and commits the cursor where it stopped", async () => {
    // Clerk's limit is per-application-instance, shared with live product
    // traffic (sign-ins are limited against the same quota), so continuing to
    // the next org would spend real users' budget to accomplish nothing.
    const t = convexTest(schema, modules)
    await seedManyOrgs(t, 10)
    const { client, requests } = fakeClerk({}, {
      failWith: (_org, count) => (count === 3 ? new ClerkRateLimited(30) : undefined),
    })

    const result = await runClerkSweep({ ctx: sweepCtx(t), client, limit: 10, now: 9_000 })

    expect(result).toMatchObject({ rate_limited: true, orgs: 2 })
    // Stopped, not skipped past: exactly the three attempts, then nothing.
    expect(requests).toHaveLength(3)
    // The cursor is the last FULLY SWEPT org, so the next run resumes at the
    // org this one was refused on rather than skipping it.
    expect(result.cursor).toBe("clerk_org_001")
    const state = await t.run(async (ctx) => ctx.db.query("clerk_sync_state").collect())
    expect(state[0]).toMatchObject({
      sweep_cursor: "clerk_org_001",
      last_sweep_rate_limited_at: 9_000,
    })
  })

  test("a 429 on the very first org keeps the incoming cursor rather than rewinding", async () => {
    // Committing `undefined` here would rewind the round-robin to the start of
    // the table on every rate-limited run, so orgs late in the index would
    // never be reached.
    const t = convexTest(schema, modules)
    await seedManyOrgs(t, 10)
    const { client } = fakeClerk({}, { failWith: () => new ClerkRateLimited(30) })

    const result = await runClerkSweep({
      ctx: sweepCtx(t),
      client,
      limit: 10,
      now: 9_000,
      cursor: "clerk_org_003",
    })

    expect(result).toMatchObject({ rate_limited: true, orgs: 0, cursor: "clerk_org_003" })
  })

  test("a non-429 per-org failure skips that org and continues", async () => {
    // Unlike a rate limit, a 5xx or a since-deleted org says nothing about
    // whether the NEXT org can be read, so the run must not abandon the rest.
    const t = convexTest(schema, modules)
    await seedManyOrgs(t, 4)
    const { client, requests } = fakeClerk({}, {
      failWith: (_org, count) => (count === 2 ? new Error("Clerk membership read failed: 503") : undefined),
    })

    const result = await runClerkSweep({ ctx: sweepCtx(t), client, limit: 4, now: 9_000 })

    expect(requests).toHaveLength(4)
    expect(result).toMatchObject({ rate_limited: false, orgs: 3 })
  })

  test("personal orgs and deleted orgs are never swept", async () => {
    // A personal org has no `clerk_org_id`, so asking Clerk about it is
    // meaningless — and a diff against an empty Clerk response would revoke the
    // owner's own membership in the one org every user has.
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", stamped({ token_identifier: "t_owner" }) as never)
      await ctx.db.insert("orgs", stamped({ kind: "personal", owner_user_id: ownerId, name: "Personal" }) as never)
      await ctx.db.insert("orgs", stamped({ clerk_org_id: "clerk_org_1", kind: "clerk", name: "Acme" }) as never)
      await ctx.db.insert("orgs", stamped({ clerk_org_id: "clerk_org_2", kind: "clerk", name: "Gone", deleted_at: 5 }) as never)
    })
    const { client, requests } = fakeClerk({})

    await runClerkSweep({ ctx: sweepCtx(t), client, limit: 10, now: 9_000 })

    expect(requests.map((request) => request.clerkOrgId)).toEqual(["clerk_org_1"])
  })
})

// ===========================================================================
// Paging and the truncation fence. No Convex runtime involved.
// ===========================================================================

describe("fetchClerkMemberships — paging and the truncation fence", () => {
  test("pages at Clerk's documented maximum page size", () => {
    // Clerk's docs: limit "must be an integer greater than zero and less than
    // 501". The maximum is the right choice against a REQUEST-COUNT budget.
    expect(CLERK_MEMBERSHIP_PAGE_SIZE).toBe(500)
  })

  test("a short page ends the walk in one request", async () => {
    const { client, requests } = fakeClerk({
      clerk_org_1: [{ clerk_subject: "clerk_user_1", role: "org:admin", updated_at: 1 }],
    })
    const result = await fetchClerkMemberships(client, "clerk_org_1")
    expect(result).toMatchObject({ truncated: false, requests: 1 })
    expect(result.memberships).toHaveLength(1)
  })

  test("a client that never terminates is capped and reported truncated", async () => {
    // The fence against an unbounded loop driven by a REMOTE response: an exit
    // condition supplied by a third party is one a third party can withhold.
    const client: ClerkClient = {
      async listMemberships({ limit }) {
        return {
          memberships: Array.from({ length: limit }, (_, index) => ({
            clerk_subject: `user_${index}`,
            role: "org:member",
            updated_at: 1,
          })),
          total: undefined,
        }
      },
    }
    const result = await fetchClerkMemberships(client, "clerk_org_1", 3)
    expect(result.truncated).toBe(true)
    expect(result.requests).toBe(3)
  })
})

// ===========================================================================
// The corrective writer re-derives rather than trusting the action.
// ===========================================================================

describe("applyReconcileCorrections re-derives every correction (W6.3)", () => {
  const apply = (t: ReturnType<typeof convexTest>, corrections: unknown[]) =>
    t.mutation(internal.clerkReconcile.applyReconcileCorrections, {
      clerk_org_id: "clerk_org_1",
      observed_at: 9_000,
      corrections,
    } as never) as Promise<{ applied: number; skipped: number }>

  test("a revoke naming a membership id that no longer matches is SKIPPED", async () => {
    // The action read its rows in an earlier transaction. If a webhook has
    // re-created the membership since, that is a NEWER fact than this sweep's
    // observation and must survive it — trusting a stale `membership_id` is
    // exactly how a sweep deletes the wrong row.
    const t = convexTest(schema, modules)
    await seedOrgFixture(t)
    const result = await apply(t, [
      { kind: "revoke", membership_id: "membership_STALE", clerk_subject: "clerk_user_1", role: "admin" },
    ])
    expect(result).toEqual({ applied: 0, skipped: 1 })
    expect(await membershipRows(t)).toHaveLength(1)
  })

  test("a role correction whose `from` no longer holds is SKIPPED", async () => {
    const t = convexTest(schema, modules)
    const { membershipId } = await seedOrgFixture(t, { role: "member" })
    const result = await apply(t, [{
      kind: "role",
      membership_id: String(membershipId),
      clerk_subject: "clerk_user_1",
      from: "admin",
      to: "member",
    }])
    expect(result).toEqual({ applied: 0, skipped: 1 })
  })

  test("an insert for an existing membership is SKIPPED, not duplicated", async () => {
    const t = convexTest(schema, modules)
    await seedOrgFixture(t)
    const result = await apply(t, [
      { kind: "insert", clerk_subject: "clerk_user_1", role: "admin", clerk_updated_at: 5_000 },
    ])
    expect(result).toEqual({ applied: 0, skipped: 1 })
    expect(await membershipRows(t)).toHaveLength(1)
  })

  test("nothing is written for an org deleted since the read", async () => {
    const t = convexTest(schema, modules)
    const { orgId } = await seedOrgFixture(t)
    await t.run(async (ctx) => ctx.db.patch(orgId, { deleted_at: 8_000 }))
    const result = await apply(t, [
      { kind: "revoke", membership_id: "whatever", clerk_subject: "clerk_user_1", role: "admin" },
    ])
    expect(result).toMatchObject({ applied: 0 })
    expect(await membershipRows(t)).toHaveLength(1)
  })

  test("a correction for a user with no Convex row is SKIPPED", async () => {
    const t = convexTest(schema, modules)
    await seedOrgFixture(t)
    const result = await apply(t, [
      { kind: "insert", clerk_subject: "clerk_ghost", role: "admin", clerk_updated_at: 5_000 },
    ])
    expect(result).toEqual({ applied: 0, skipped: 1 })
    // The fixture's own membership is untouched — nothing added, nothing removed.
    expect(await membershipRows(t)).toHaveLength(1)
  })
})

// ===========================================================================
// Tombstone TTL.
// ===========================================================================

describe("tombstone retention (W6.3)", () => {
  test("retention outlasts the Svix redelivery envelope", () => {
    // Sized against the window it must survive, not chosen for roundness: Svix
    // retries a message ~27.5h and disables an endpoint only after 5 days of
    // failures, after which queued messages can flow days late. Expiring too
    // EARLY reopens the resurrection hole, so the margin is deliberate.
    expect(CLERK_TOMBSTONE_RETAIN_MS).toBeGreaterThan(7 * 24 * 60 * 60 * 1_000)
  })

  test("tombstones past retention are reaped and fresh ones are kept", async () => {
    // Without a reaper this table grows one row per revoked membership forever
    // — the same unbounded-growth shape the W5 retention cron exists for.
    const t = convexTest(schema, modules)
    const now = Date.now()
    const freshId = await t.run(async (ctx) => {
      await ctx.db.insert("clerk_membership_tombstones", {
        clerk_org_id: "o",
        clerk_subject: "a",
        clerk_updated_at: 1,
        source: "webhook",
        created_at: now - 40 * 24 * 60 * 60 * 1_000,
      } as never)
      return await ctx.db.insert("clerk_membership_tombstones", {
        clerk_org_id: "o",
        clerk_subject: "b",
        clerk_updated_at: 1,
        source: "webhook",
        created_at: now - 60_000,
      } as never)
    })

    const result = await t.mutation(internal.clerkReconcile.reapMembershipTombstones, {
      retain_ms: CLERK_TOMBSTONE_RETAIN_MS,
      limit: 100,
    } as never)

    expect(result).toEqual({ deleted: 1 })
    const remaining = await tombstoneRows(t)
    expect(remaining.map((row) => row._id)).toEqual([freshId])
  })
})

// ===========================================================================
// Webhook liveness.
// ===========================================================================

describe("webhook-liveness flag (W6.3 item 4)", () => {
  const flag = (t: ReturnType<typeof convexTest>, now: number) =>
    t.mutation(internal.clerkReconcile.flagStaleClerkWebhooks, {
      stale_after_ms: 24 * 60 * 60 * 1_000,
      now,
    } as never) as Promise<{ flagged: boolean; reason: string }>

  test("a silent channel with live Clerk orgs is FLAGGED", async () => {
    // Svix disables an endpoint after 5 days of failed deliveries, which stops
    // every event type at once and is otherwise completely silent.
    const t = convexTest(schema, modules)
    const now = 100 * 60 * 60 * 1_000
    await t.run(async (ctx) => {
      await ctx.db.insert("orgs", stamped({ clerk_org_id: "clerk_org_1", kind: "clerk", name: "Acme" }) as never)
      await ctx.db.insert("clerk_sync_state", { ...WEBHOOK_SEEN, last_webhook_at: now - 48 * 60 * 60 * 1_000 } as never)
    })
    const result = await flag(t, now)
    expect(result).toMatchObject({ flagged: true, reason: "stale" })
    const state = await t.run(async (ctx) => ctx.db.query("clerk_sync_state").collect())
    expect(state[0]).toMatchObject({ webhook_stale_flagged_at: now })
  })

  test("a recent webhook is not flagged", async () => {
    const t = convexTest(schema, modules)
    const now = 100 * 60 * 60 * 1_000
    await t.run(async (ctx) => {
      await ctx.db.insert("orgs", stamped({ clerk_org_id: "clerk_org_1", kind: "clerk", name: "Acme" }) as never)
      await ctx.db.insert("clerk_sync_state", { ...WEBHOOK_SEEN, last_webhook_at: now - 60_000 } as never)
    })
    expect(await flag(t, now)).toMatchObject({ flagged: false, reason: "fresh" })
  })

  test("a deployment with no live Clerk orgs is not flagged", async () => {
    // Otherwise the flag would be permanently lit on every fresh and
    // self-hosted deployment, which is how a signal becomes noise.
    const t = convexTest(schema, modules)
    const now = 100 * 60 * 60 * 1_000
    await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", stamped({ token_identifier: "t_owner" }) as never)
      await ctx.db.insert("orgs", stamped({ kind: "personal", owner_user_id: ownerId, name: "Personal" }) as never)
      await ctx.db.insert("clerk_sync_state", { ...WEBHOOK_SEEN, last_webhook_at: now - 48 * 60 * 60 * 1_000 } as never)
    })
    expect(await flag(t, now)).toMatchObject({ flagged: false, reason: "no_clerk_orgs" })
  })

  test("orgs deleted at the head of the index do not mask a live org", async () => {
    // The liveness probe reads a bounded window and filters `deleted_at` in JS,
    // so a run of deleted orgs must not read as "no Clerk orgs" — that would
    // silence the flag on exactly the deployments old enough to have churn.
    const t = convexTest(schema, modules)
    const now = 100 * 60 * 60 * 1_000
    const deletedCount = 5
    await t.run(async (ctx) => {
      for (let index = 0; index < deletedCount; index++) {
        await ctx.db.insert("orgs", stamped({
          clerk_org_id: `clerk_org_00${index}`,
          kind: "clerk",
          name: "Gone",
          deleted_at: 5,
        }) as never)
      }
      await ctx.db.insert("orgs", stamped({ clerk_org_id: "clerk_org_zzz", kind: "clerk", name: "Acme" }) as never)
      await ctx.db.insert("clerk_sync_state", { ...WEBHOOK_SEEN, last_webhook_at: now - 48 * 60 * 60 * 1_000 } as never)
    })
    expect(await flag(t, now)).toMatchObject({ flagged: true })
    expect(CLERK_LIVENESS_ORG_PROBE).toBeGreaterThan(deletedCount)
  })

  test("a deployment that has never seen a webhook is not flagged", async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert("orgs", stamped({ clerk_org_id: "clerk_org_1", kind: "clerk", name: "Acme" }) as never)
    })
    expect(await flag(t, 1_000)).toMatchObject({ flagged: false, reason: "never_seen" })
  })

  test("the flag does not re-fire while already set", async () => {
    const t = convexTest(schema, modules)
    const now = 100 * 60 * 60 * 1_000
    await t.run(async (ctx) => {
      await ctx.db.insert("orgs", stamped({ clerk_org_id: "clerk_org_1", kind: "clerk", name: "Acme" }) as never)
      await ctx.db.insert("clerk_sync_state", {
        ...WEBHOOK_SEEN,
        last_webhook_at: now - 48 * 60 * 60 * 1_000,
        webhook_stale_flagged_at: now - 1_000,
      } as never)
    })
    expect(await flag(t, now)).toMatchObject({ flagged: false, reason: "already_flagged" })
  })

  test("ANY verified webhook stamps liveness and CLEARS the flag", async () => {
    // Self-clearing, exactly like billing's `billing_reconcile_flagged_at`: a
    // flag an operator must clear by hand stays lit after the incident and
    // stops meaning anything.
    //
    // "Any type" is deliberate — an unhandled event type proves the channel is
    // delivering just as well as a handled one, and the question this answers is
    // whether the channel is alive at all.
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert("clerk_sync_state", { ...WEBHOOK_SEEN, last_webhook_at: 1_000, webhook_stale_flagged_at: 5_000 } as never)
    })

    await t.mutation(internal.orgs.applyClerkWebhook, { type: "session.created", data: {} } as never)

    const state = await t.run(async (ctx) => ctx.db.query("clerk_sync_state").collect())
    expect(state[0]!.last_webhook_type).toBe("session.created")
    // `toMatchObject({ webhook_stale_flagged_at: undefined })` would pass
    // whether the field was cleared OR never asserted at all against a real
    // Convex row; asserted separately, this pins that the patch actually
    // UNSET the key.
    expect(state[0]!.webhook_stale_flagged_at).toBeUndefined()
    expect(state[0]!.last_webhook_at).toBeGreaterThan(1_000)
  })
})
