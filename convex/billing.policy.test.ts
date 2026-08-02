import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { convexTest } from "convex-test"
import { api, internal } from "./_generated/api"
import { enforceSeatCapacity } from "./billing"
import schema from "./schema"

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob("./**/*.ts")

/**
 * Every table here requires `created_at`/`updated_at`. The hand-rolled `db`
 * double this suite used to run against enforced nothing, so its seeds were
 * missing them and the schema drift went unnoticed.
 */
const stamped = <T extends Record<string, unknown>>(row: T) => ({ created_at: 1, updated_at: 1, ...row })

/**
 * D5/D6 Convex policy (ADR 014 §3/§4), run through the real `serviceMutation`/
 * `serviceQuery`/`authedMutation`/`cronMutation`/`webhookMutation` wrappers via
 * `convex-test`:
 * - applyPolarState is idempotent under duplicates and REORDERING (older
 *   source timestamps never overwrite newer state);
 * - full-state sources downgrade previously mirrored orgs absent from the
 *   payload; subscription events never touch siblings;
 * - the past_due carve-out preserves the grace window against customer-state
 *   payloads that omit dunning subscriptions;
 * - seat hard-block: new memberships beyond seats_licensed throw the typed
 *   seat_limit_reached error; personal-org owner membership always allowed.
 *
 * The previous version of this suite drove a hand-written `db` double (with a
 * bespoke index-range builder, `convex-index-harness.ts`) and reached past the
 * builders into `_handler`, so it never exercised the `service_token` check,
 * identity resolution, or the real index/`.unique()` semantics these depend on.
 */

const SERVICE_TOKEN = "svc_test_token"

const PRO_STATE = {
  plan: "pro" as const,
  subscription_status: "active",
  polar_subscription_id: "sub_1",
  seats_licensed: 3,
  current_period_end: 1_900_000_000_000,
}

beforeEach(() => {
  vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", SERVICE_TOKEN)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

async function seedOrg(t: ReturnType<typeof convexTest>, overrides: Record<string, unknown> = {}) {
  return await t.run(async (ctx) =>
    ctx.db.insert(
      "orgs",
      stamped({ name: "Acme", kind: "clerk", clerk_org_id: "clerk_org_1", ...overrides }) as never,
    )
  )
}

async function getOrg(t: ReturnType<typeof convexTest>, id: unknown) {
  return await t.run(async (ctx) => ctx.db.get(id as never))
}

const apply = (t: ReturnType<typeof convexTest>, args: Record<string, unknown>) =>
  t.mutation(api.billing.applyPolarState, { service_token: SERVICE_TOKEN, ...args } as never) as Promise<{
    results: Array<{ org_id: string; applied: boolean; reason?: string }>
    unresolved: string[]
  }>

describe("applyPolarState (D5 single writer)", () => {
  test("applies fresh state, stamps guard fields, clears the reconcile flag", async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t, { billing_reconcile_flagged_at: 123 })

    const result = await apply(t, {
      polar_customer_id: "cus_1",
      source_ts: 1000,
      source: "customer_state",
      org_states: [{ org_id: String(orgId), state: PRO_STATE }],
    })
    expect(result.results).toEqual([{ org_id: String(orgId), applied: true }])
    const org = (await getOrg(t, orgId))!
    expect(org).toMatchObject({
      plan: "pro",
      polar_customer_id: "cus_1",
      polar_subscription_id: "sub_1",
      seats_licensed: 3,
      subscription_status: "active",
      polar_state_modified_at: 1000,
    })
    expect(org.billing_reconcile_flagged_at).toBeUndefined()
    expect(typeof org.billing_synced_at).toBe("number")
  })

  test("out-of-order/duplicate deliveries are no-ops (source-timestamp guard)", async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)

    await apply(t, {
      polar_customer_id: "cus_1",
      source_ts: 2000,
      source: "customer_state",
      org_states: [{ org_id: String(orgId), state: PRO_STATE }],
    })
    // Older payload claims the subscription was canceled — must NOT win.
    const stale = await apply(t, {
      polar_customer_id: "cus_1",
      source_ts: 1000,
      source: "subscription_event",
      org_states: [{ org_id: String(orgId), state: { plan: "free", subscription_status: "canceled" } }],
    })
    expect(stale.results).toEqual([{ org_id: String(orgId), applied: false, reason: "stale_source" }])
    // Exact duplicate (same ts) is also a no-op.
    const dupe = await apply(t, {
      polar_customer_id: "cus_1",
      source_ts: 2000,
      source: "customer_state",
      org_states: [{ org_id: String(orgId), state: PRO_STATE }],
    })
    expect(dupe.results[0]).toMatchObject({ applied: false, reason: "stale_source" })
    expect(await getOrg(t, orgId)).toMatchObject({ plan: "pro", subscription_status: "active" })
  })

  test("F6: a reconciliation confirming unchanged state clears the flag and advances billing_synced_at", async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t)

    await apply(t, {
      polar_customer_id: "cus_1",
      source_ts: 2000,
      source: "customer_state",
      org_states: [{ org_id: String(orgId), state: PRO_STATE }],
    })
    // Simulate the cron having flagged the org for reconciliation, and time moving on.
    await t.run(async (ctx) => ctx.db.patch(orgId, { billing_reconcile_flagged_at: 9999, billing_synced_at: 2000 }))
    // The sweep re-fetches Polar and gets the SAME modified_at (2000) — equal, not newer.
    const swept = await apply(t, {
      polar_customer_id: "cus_1",
      source_ts: 2000,
      source: "reconciliation",
      org_states: [{ org_id: String(orgId), state: PRO_STATE }],
    })
    // Subscription state untouched (nothing changed) but the flag MUST clear,
    // else the org is re-fetched every sweep forever.
    expect(swept.results[0]).toMatchObject({ applied: false, reason: "stale_source_reconcile_confirmed" })
    let org = (await getOrg(t, orgId))!
    expect(org.billing_reconcile_flagged_at).toBeUndefined()
    expect(org.billing_synced_at).toBeGreaterThan(2000)
    expect(org).toMatchObject({ plan: "pro", subscription_status: "active" })
    // The same equal-timestamp payload from a NON-reconciliation source stays a plain no-op (no flag semantics).
    await t.run(async (ctx) => ctx.db.patch(orgId, { billing_reconcile_flagged_at: 8888 }))
    const dupe = await apply(t, {
      polar_customer_id: "cus_1",
      source_ts: 2000,
      source: "customer_state",
      org_states: [{ org_id: String(orgId), state: PRO_STATE }],
    })
    expect(dupe.results[0]).toMatchObject({ applied: false, reason: "stale_source" })
    org = (await getOrg(t, orgId))!
    expect(org.billing_reconcile_flagged_at).toBe(8888)
  })

  test("full-state payload downgrades a previously mirrored org absent from it; a newer subscription event re-upgrades", async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t, {
      polar_customer_id: "cus_1",
      plan: "pro",
      subscription_status: "active",
      polar_state_modified_at: 1000,
      seats_licensed: 3,
    })

    const result = await apply(t, { polar_customer_id: "cus_1", source_ts: 2000, source: "customer_state", org_states: [] })
    expect(result.results).toEqual([{ org_id: String(orgId), applied: true }])
    let org = (await getOrg(t, orgId))!
    expect(org).toMatchObject({ plan: "free", subscription_status: "none" })
    expect(org.polar_subscription_id).toBeUndefined()
    expect(org.seats_licensed).toBeUndefined()

    const upgrade = await apply(t, {
      polar_customer_id: "cus_1",
      source_ts: 3000,
      source: "subscription_event",
      org_states: [{ org_id: String(orgId), state: PRO_STATE }],
    })
    expect(upgrade.results).toEqual([{ org_id: String(orgId), applied: true }])
    org = (await getOrg(t, orgId))!
    expect(org).toMatchObject({ plan: "pro", seats_licensed: 3 })
  })

  test("subscription events never touch sibling orgs on the same customer", async () => {
    const t = convexTest(schema, modules)
    const orgAId = await seedOrg(t, { clerk_org_id: "clerk_org_1", polar_customer_id: "cus_1", plan: "pro", subscription_status: "active", polar_state_modified_at: 1000 })
    const orgBId = await seedOrg(t, { clerk_org_id: "clerk_org_2", polar_customer_id: "cus_1", plan: "pro", subscription_status: "active", polar_state_modified_at: 1000 })

    await apply(t, {
      polar_customer_id: "cus_1",
      source_ts: 2000,
      source: "subscription_event",
      org_states: [{ org_id: String(orgAId), state: { plan: "free", subscription_status: "canceled" } }],
    })
    expect(await getOrg(t, orgAId)).toMatchObject({ plan: "free" })
    expect(await getOrg(t, orgBId)).toMatchObject({ plan: "pro", subscription_status: "active" })
  })

  test("past_due carve-out: a customer-state payload without the dunning subscription keeps the past_due mirror (grace preserved)", async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t, { polar_customer_id: "cus_1", plan: "pro", subscription_status: "past_due", polar_state_modified_at: 1000, seats_licensed: 3 })

    const result = await apply(t, { polar_customer_id: "cus_1", source_ts: 2000, source: "customer_state", org_states: [] })
    expect(result.results[0]).toMatchObject({ applied: false, reason: "past_due_grace_preserved" })
    expect(await getOrg(t, orgId)).toMatchObject({ plan: "pro", subscription_status: "past_due", seats_licensed: 3 })

    // The EXPLICIT terminal event still downgrades — dunning genuinely over.
    await apply(t, {
      polar_customer_id: "cus_1",
      source_ts: 3000,
      source: "subscription_event",
      org_states: [{ org_id: String(orgId), state: { plan: "free", subscription_status: "revoked" } }],
    })
    expect(await getOrg(t, orgId)).toMatchObject({ plan: "free", subscription_status: "revoked" })
  })

  test("F11: past_due_since anchors on the FIRST transition and is preserved across dunning retries", async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t, { polar_customer_id: "cus_1", plan: "pro", subscription_status: "active", polar_state_modified_at: 500, seats_licensed: 3 })
    const pastDue = { plan: "pro" as const, subscription_status: "past_due", polar_subscription_id: "sub_1", seats_licensed: 3 }

    // First past_due transition stamps the anchor.
    await apply(t, { polar_customer_id: "cus_1", source_ts: 1000, source: "subscription_event", org_states: [{ org_id: String(orgId), state: pastDue }] })
    let org = (await getOrg(t, orgId))!
    const anchor = org.past_due_since
    expect(typeof anchor).toBe("number")

    // Two more dunning retries (newer source timestamps → they DO apply) must
    // NOT re-anchor: the grace window measures from the first transition.
    await apply(t, { polar_customer_id: "cus_1", source_ts: 2000, source: "subscription_event", org_states: [{ org_id: String(orgId), state: pastDue }] })
    await apply(t, { polar_customer_id: "cus_1", source_ts: 3000, source: "subscription_event", org_states: [{ org_id: String(orgId), state: pastDue }] })
    org = (await getOrg(t, orgId))!
    expect(org.past_due_since).toBe(anchor)
    expect(org).toMatchObject({ subscription_status: "past_due", polar_state_modified_at: 3000 })

    // Leaving past_due (recovery) clears the anchor so a future dunning cycle re-stamps.
    await apply(t, { polar_customer_id: "cus_1", source_ts: 4000, source: "subscription_event", org_states: [{ org_id: String(orgId), state: PRO_STATE }] })
    org = (await getOrg(t, orgId))!
    expect(org.past_due_since).toBeUndefined()
    expect(org).toMatchObject({ subscription_status: "active" })
  })

  test("preserve_seats keeps the mirrored seat count when the payload omits seats", async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t, { polar_customer_id: "cus_1", plan: "pro", subscription_status: "active", seats_licensed: 5, polar_state_modified_at: 1000 })

    await apply(t, {
      polar_customer_id: "cus_1",
      source_ts: 2000,
      source: "customer_state",
      org_states: [{ org_id: String(orgId), state: { ...PRO_STATE, seats_licensed: undefined, preserve_seats: true } }],
    })
    expect(await getOrg(t, orgId)).toMatchObject({ plan: "pro", seats_licensed: 5 })
  })

  test("unknown metadata.org_id is reported as unresolved, nothing thrown", async () => {
    const t = convexTest(schema, modules)
    const result = await apply(t, {
      polar_customer_id: "cus_1",
      source_ts: 1000,
      source: "subscription_event",
      org_states: [{ org_id: "org_ghost", state: PRO_STATE }],
    })
    expect(result).toEqual({ results: [], unresolved: ["org_ghost"] })
  })

  test("rejects a bad service token (builder-gated)", async () => {
    const t = convexTest(schema, modules)
    await seedOrg(t)
    await expect(
      t.mutation(api.billing.applyPolarState, {
        service_token: "wrong",
        polar_customer_id: "cus_1",
        source_ts: 1,
        source: "customer_state",
        org_states: [],
      } as never),
    ).rejects.toThrow("Unauthenticated")
  })
})

describe("entitlementState read model", () => {
  test("resolves by org id or clerk org id; unknown org reads as not found (free tier)", async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t, { plan: "pro", subscription_status: "active", seats_licensed: 3, polar_state_modified_at: 1000, billing_synced_at: 1500 })

    const byOrg = await t.query(api.billing.entitlementState, { service_token: SERVICE_TOKEN, org_id: String(orgId) } as never)
    expect(byOrg).toMatchObject({ found: true, plan: "pro", subscription_status: "active", seats_licensed: 3 })
    const byClerk = await t.query(api.billing.entitlementState, { service_token: SERVICE_TOKEN, clerk_org_id: "clerk_org_1" } as never)
    expect(byClerk).toMatchObject({ found: true, org_id: String(orgId) })
    const missing = await t.query(api.billing.entitlementState, { service_token: SERVICE_TOKEN, org_id: "org_ghost" } as never)
    expect(missing).toEqual({ found: false })
  })

  test("F11: entitlementState surfaces past_due_since (the grace anchor)", async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t, { plan: "pro", subscription_status: "past_due", past_due_since: 1234, polar_state_modified_at: 5000, billing_synced_at: 6000 })

    const state = await t.query(api.billing.entitlementState, { service_token: SERVICE_TOKEN, org_id: String(orgId) } as never)
    expect(state).toMatchObject({ found: true, subscription_status: "past_due", past_due_since: 1234 })
  })

  test("deleted orgs read as not found (fail-closed)", async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t, { plan: "pro", subscription_status: "active", deleted_at: 99 })

    expect(await t.query(api.billing.entitlementState, { service_token: SERVICE_TOKEN, org_id: String(orgId) } as never))
      .toEqual({ found: false })
  })

  test("F1: surfaces the current member_count so the entitlement layer can enforce seats", async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t, { plan: "pro", subscription_status: "active", seats_licensed: 2 })
    await t.run(async (ctx) => {
      const owner = await ctx.db.insert("users", stamped({ token_identifier: "t_owner" }) as never)
      const member1 = await ctx.db.insert("users", stamped({ token_identifier: "t_1" }) as never)
      const member2 = await ctx.db.insert("users", stamped({ token_identifier: "t_2" }) as never)
      await ctx.db.insert("org_memberships", stamped({ org_id: orgId, user_id: owner, role: "owner" }) as never)
      await ctx.db.insert("org_memberships", stamped({ org_id: orgId, user_id: member1, role: "member" }) as never)
      await ctx.db.insert("org_memberships", stamped({ org_id: orgId, user_id: member2, role: "member" }) as never)
    })

    const state = await t.query(api.billing.entitlementState, { service_token: SERVICE_TOKEN, org_id: String(orgId) } as never)
    expect(state).toMatchObject({ found: true, seats_licensed: 2, member_count: 3 })
  })
})

describe("seat enforcement (D6 + F1: mirror never throws, entitlement enforces)", () => {
  const membershipEvent = (clerkSubject: string) => ({
    type: "organizationMembership.created",
    data: {
      organization: { id: "clerk_org_1", name: "Acme", updated_at: 10 },
      public_user_data: { user_id: clerkSubject },
      role: "member",
      updated_at: 10,
    },
  })

  async function seedSeatOrg(t: ReturnType<typeof convexTest>, input: { seats?: number; members: number }) {
    return await t.run(async (ctx) => {
      const orgId = await ctx.db.insert(
        "orgs",
        stamped({
          name: "Acme",
          kind: "clerk",
          clerk_org_id: "clerk_org_1",
          ...(input.seats === undefined ? {} : { seats_licensed: input.seats, plan: "pro", subscription_status: "active" }),
        }) as never,
      )
      await ctx.db.insert("users", stamped({ clerk_subject: "clerk_user_new", token_identifier: "t_new" }) as never)
      const memberIds: unknown[] = []
      for (let index = 0; index < input.members; index++) {
        const userId = await ctx.db.insert("users", stamped({ clerk_subject: `clerk_user_${index}`, token_identifier: `t_${index}` }) as never)
        memberIds.push(userId)
        await ctx.db.insert("org_memberships", stamped({ org_id: orgId, user_id: userId, role: "member" }) as never)
      }
      return { orgId, memberIds }
    })
  }

  async function membershipsOf(t: ReturnType<typeof convexTest>, orgId: unknown) {
    return await t.run(async (ctx) => (await ctx.db.query("org_memberships").collect()).filter((row) => row.org_id === orgId))
  }

  test("a member add UNDER the licensed seat count succeeds", async () => {
    const t = convexTest(schema, modules)
    const { orgId } = await seedSeatOrg(t, { seats: 3, members: 2 })
    await t.mutation(internal.orgs.applyClerkWebhook, membershipEvent("clerk_user_new") as never)
    expect(await membershipsOf(t, orgId)).toHaveLength(3)
  })

  test("F1: a member add AT/OVER the licensed seat count STILL SYNCS — the mirror never throws", async () => {
    // Regression for F1: enforceSeatCapacity used to throw here, 500ing the
    // whole Svix delivery and wedging the mirror (revocations included). The
    // over-cap join must now sync cleanly; the seat ceiling is enforced later,
    // at the entitlement layer.
    const t = convexTest(schema, modules)
    const { orgId } = await seedSeatOrg(t, { seats: 3, members: 3 })
    await expect(t.mutation(internal.orgs.applyClerkWebhook, membershipEvent("clerk_user_new") as never))
      .resolves.toEqual({ ok: true })
    expect(await membershipsOf(t, orgId)).toHaveLength(4)
  })

  test("updating an EXISTING member's role is never seat-blocked", async () => {
    const t = convexTest(schema, modules)
    const { orgId, memberIds } = await seedSeatOrg(t, { seats: 2, members: 2 })
    await t.mutation(internal.orgs.applyClerkWebhook, {
      type: "organizationMembership.updated",
      data: {
        organization: { id: "clerk_org_1", name: "Acme", updated_at: 20 },
        public_user_data: { user_id: "clerk_user_0" },
        role: "admin",
        updated_at: 20,
      },
    } as never)
    const memberships = await membershipsOf(t, orgId)
    expect(memberships.find((row) => row.user_id === memberIds[0])).toMatchObject({ role: "admin" })
  })

  test("an org WITHOUT seats_licensed (free tier) accepts members — invite-before-subscribe", async () => {
    const t = convexTest(schema, modules)
    const { orgId } = await seedSeatOrg(t, { members: 5 })
    await t.mutation(internal.orgs.applyClerkWebhook, membershipEvent("clerk_user_new") as never)
    expect(await membershipsOf(t, orgId)).toHaveLength(6)
  })

  test("personal-org owner membership always bypasses the seat check", async () => {
    const t = convexTest(schema, modules)
    const { ownerId, otherId, personalOrg } = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", stamped({ token_identifier: "t_owner" }) as never)
      const otherId = await ctx.db.insert("users", stamped({ token_identifier: "t_other" }) as never)
      const personalOrgId = await ctx.db.insert(
        "orgs",
        stamped({ name: "Personal", kind: "personal", owner_user_id: ownerId, seats_licensed: 0 }) as never,
      )
      const personalOrg = await ctx.db.get(personalOrgId)
      return { ownerId, otherId, personalOrg }
    })

    await t.run(async (ctx) => {
      // Even a nonsensical zero-seat license cannot block the owner's own row.
      await expect(enforceSeatCapacity(ctx, personalOrg, ownerId)).resolves.toBeUndefined()
      // …but the same personal org cannot take a SECOND member past its license.
      await expect(enforceSeatCapacity(ctx, personalOrg, otherId)).rejects.toThrow(/^seat_limit_reached/)
    })
  })
})

describe("F12: membershipByClerkIds (connections-gate re-check)", () => {
  async function seedMembershipFixture(t: ReturnType<typeof convexTest>, orgOverrides: Record<string, unknown> = {}) {
    return await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("orgs", stamped({ name: "Acme", kind: "clerk", clerk_org_id: "clerk_org_1", ...orgOverrides }) as never)
      const memberId = await ctx.db.insert("users", stamped({ clerk_subject: "clerk_member", token_identifier: "t_member" }) as never)
      await ctx.db.insert("users", stamped({ clerk_subject: "clerk_outsider", token_identifier: "t_outsider" }) as never)
      await ctx.db.insert("org_memberships", stamped({ org_id: orgId, user_id: memberId, role: "admin" }) as never)
      return { orgId, memberId }
    })
  }

  const check = (t: ReturnType<typeof convexTest>, args: Record<string, unknown>) =>
    t.query(api.orgs.membershipByClerkIds, { service_token: SERVICE_TOKEN, ...args } as never)

  test("a real member of the claimed org resolves member:true with the role", async () => {
    const t = convexTest(schema, modules)
    const { orgId, memberId } = await seedMembershipFixture(t)
    const result = await check(t, { clerk_org_id: "clerk_org_1", clerk_subject: "clerk_member" })
    expect(result).toEqual({ member: true, org_id: String(orgId), user_id: String(memberId), role: "admin" })
  })

  test("a subject with no membership in the claimed org is member:false (stale/forged claim)", async () => {
    const t = convexTest(schema, modules)
    await seedMembershipFixture(t)
    const result = await check(t, { clerk_org_id: "clerk_org_1", clerk_subject: "clerk_outsider" })
    expect(result).toEqual({ member: false })
  })

  test("unknown org id and unknown subject both fail closed (member:false)", async () => {
    const t = convexTest(schema, modules)
    await seedMembershipFixture(t)
    expect(await check(t, { clerk_org_id: "clerk_ghost", clerk_subject: "clerk_member" })).toEqual({ member: false })
    expect(await check(t, { clerk_org_id: "clerk_org_1", clerk_subject: "clerk_nobody" })).toEqual({ member: false })
  })

  test("a deleted org never confirms membership", async () => {
    const t = convexTest(schema, modules)
    await seedMembershipFixture(t, { deleted_at: 42 })
    expect(await check(t, { clerk_org_id: "clerk_org_1", clerk_subject: "clerk_member" })).toEqual({ member: false })
  })

  test("rejects a bad service token (builder-gated)", async () => {
    const t = convexTest(schema, modules)
    await seedMembershipFixture(t)
    await expect(
      t.query(api.orgs.membershipByClerkIds, { service_token: "wrong", clerk_org_id: "clerk_org_1", clerk_subject: "clerk_member" } as never),
    ).rejects.toThrow("Unauthenticated")
  })
})

describe("reconciliation flagging (D5 Convex half)", () => {
  test("flags orgs with stale/absent billing_synced_at; skips fresh, already-flagged, deleted, and Polar-less orgs", async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const staleId = await seedOrg(t, { clerk_org_id: "c1", polar_customer_id: "cus_1", billing_synced_at: now - 48 * 60 * 60 * 1000 })
    const neverSyncedId = await seedOrg(t, { clerk_org_id: "c2", polar_customer_id: "cus_2" })
    await seedOrg(t, { clerk_org_id: "c3", polar_customer_id: "cus_3", billing_synced_at: now })
    const flaggedId = await seedOrg(t, { clerk_org_id: "c4", polar_customer_id: "cus_4", billing_reconcile_flagged_at: now })
    await seedOrg(t, { clerk_org_id: "c5" })
    await seedOrg(t, { clerk_org_id: "c6", polar_customer_id: "cus_6", deleted_at: 1 })

    const result = await t.mutation(internal.billing.flagStaleBillingSync, { stale_after_ms: 24 * 60 * 60 * 1000 } as never)
    expect(result).toEqual({ flagged: 2 })
    const flagged = await t.query(api.billing.listReconcileFlagged, { service_token: SERVICE_TOKEN } as never) as Array<{ org_id: string }>
    expect(flagged.map((entry) => entry.org_id).sort()).toEqual([String(flaggedId), String(neverSyncedId), String(staleId)].sort())
  })
})

describe("checkoutContext", () => {
  test("reports the caller's clerk org + role when a member; falls back to the personal org as owner", async () => {
    const t = convexTest(schema, modules)
    const orgId = await seedOrg(t, { plan: "pro", seats_licensed: 3, polar_customer_id: "cus_1" })
    await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", stamped({ clerk_subject: "clerk_user_1", token_identifier: "token_1" }) as never)
      const otherId = await ctx.db.insert("users", stamped({ token_identifier: "token_2" }) as never)
      await ctx.db.insert("org_memberships", stamped({ org_id: orgId, user_id: userId, role: "admin" }) as never)
      await ctx.db.insert("org_memberships", stamped({ org_id: orgId, user_id: otherId, role: "member" }) as never)
    })

    const caller = t.withIdentity({ tokenIdentifier: "token_1", subject: "clerk_user_1", issuer: "clerk" })
    const inOrg = await caller.mutation(api.billing.checkoutContext, { clerk_org_id: "clerk_org_1" } as never)
    expect(inOrg).toMatchObject({ org_id: String(orgId), role: "admin", member_count: 2, plan: "pro", polar_customer_id: "cus_1" })

    // No org claim → the personal org (created on first touch), role owner.
    const personal = await caller.mutation(api.billing.checkoutContext, {} as never) as { org_id: string; role: string; member_count: number }
    expect(personal).toMatchObject({ role: "owner", member_count: 1 })
    expect(personal.org_id).not.toBe(String(orgId))
  })
})
