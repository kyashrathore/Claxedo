import { afterAll, beforeAll, describe, expect, test } from "vitest"
import {
  applyPolarState,
  checkoutContext,
  enforceSeatCapacity,
  entitlementState,
  flagStaleBillingSync,
  listReconcileFlagged,
} from "../../../../convex/billing"
import { applyClerkWebhook } from "../../../../convex/orgs"

/**
 * D5/D6 Convex policy (launch plan 012; ADR 014 §3/§4):
 * - applyPolarState is idempotent under duplicates and REORDERING (older
 *   source timestamps never overwrite newer state);
 * - full-state sources downgrade previously mirrored orgs absent from the
 *   payload; subscription events never touch siblings;
 * - the past_due carve-out preserves the grace window against customer-state
 *   payloads that omit dunning subscriptions;
 * - seat hard-block: new memberships beyond seats_licensed throw the typed
 *   seat_limit_reached error; personal-org owner membership always allowed.
 */

type Row = Record<string, unknown> & { _id: string }

function db(seed: Record<string, Row[]>) {
  const rows: Record<string, Row[]> = Object.fromEntries(
    Object.entries(seed).map(([key, value]) => [key, value.map((row) => ({ ...row }))]),
  )
  let nextId = 1
  const find = (id: unknown) => {
    for (const table of Object.keys(rows)) {
      const row = rows[table]!.find((item) => item._id === id)
      if (row) return { table, row }
    }
    return undefined
  }
  return {
    rows,
    query(table: string) {
      const filters: Array<[string, unknown]> = []
      const query = {
        withIndex(_name: string, build: (q: { eq: (key: string, value: unknown) => unknown }) => unknown) {
          build({
            eq(key, value) {
              filters.push([key, value])
              return this
            },
          })
          return query
        },
        async collect() {
          return (rows[table] ?? []).filter((row) => filters.every(([key, value]) => row[key] === value))
        },
        async unique() {
          return (await query.collect())[0] ?? null
        },
      }
      return query
    },
    async get(id: unknown) {
      return find(id)?.row ?? null
    },
    async insert(table: string, doc: Record<string, unknown>) {
      const _id = `${table}_${nextId++}`
      rows[table] = rows[table] ?? []
      rows[table]!.push({ _id, ...doc })
      return _id
    },
    async patch(id: unknown, patch: Record<string, unknown>) {
      const found = find(id)
      if (!found) throw new Error(`Missing row ${String(id)}`)
      Object.assign(found.row, patch)
    },
    async delete(id: unknown) {
      const found = find(id)
      if (!found) throw new Error(`Missing row ${String(id)}`)
      rows[found.table]!.splice(rows[found.table]!.indexOf(found.row), 1)
    },
  }
}

function handler(fn: unknown) {
  return (fn as { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<any> })._handler
}

const SERVICE_TOKEN = "svc_test_token"
const previousToken = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN

beforeAll(() => {
  process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = SERVICE_TOKEN
})

afterAll(() => {
  if (previousToken === undefined) delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
  else process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = previousToken
})

const PRO_STATE = {
  plan: "pro" as const,
  subscription_status: "active",
  polar_subscription_id: "sub_1",
  seats_licensed: 3,
  current_period_end: 1_900_000_000_000,
}

const apply = (store: unknown, args: Record<string, unknown>) =>
  handler(applyPolarState)({ db: store }, { service_token: SERVICE_TOKEN, ...args })

function orgSeed(overrides: Record<string, unknown> = {}): Row {
  return { _id: "org_1", name: "Acme", kind: "clerk", clerk_org_id: "clerk_org_1", created_at: 1, updated_at: 1, ...overrides }
}

describe("applyPolarState (D5 single writer)", () => {
  test("applies fresh state, stamps guard fields, clears the reconcile flag", async () => {
    const store = db({ orgs: [orgSeed({ billing_reconcile_flagged_at: 123 })] })
    const result = await apply(store, {
      polar_customer_id: "cus_1",
      source_ts: 1000,
      source: "customer_state",
      org_states: [{ org_id: "org_1", state: PRO_STATE }],
    })
    expect(result.results).toEqual([{ org_id: "org_1", applied: true }])
    const org = store.rows.orgs![0]!
    expect(org).toMatchObject({
      plan: "pro",
      polar_customer_id: "cus_1",
      polar_subscription_id: "sub_1",
      seats_licensed: 3,
      subscription_status: "active",
      polar_state_modified_at: 1000,
      billing_reconcile_flagged_at: undefined,
    })
    expect(typeof org.billing_synced_at).toBe("number")
  })

  test("out-of-order/duplicate deliveries are no-ops (source-timestamp guard)", async () => {
    const store = db({ orgs: [orgSeed()] })
    await apply(store, {
      polar_customer_id: "cus_1",
      source_ts: 2000,
      source: "customer_state",
      org_states: [{ org_id: "org_1", state: PRO_STATE }],
    })
    // Older payload claims the subscription was canceled — must NOT win.
    const stale = await apply(store, {
      polar_customer_id: "cus_1",
      source_ts: 1000,
      source: "subscription_event",
      org_states: [{ org_id: "org_1", state: { plan: "free", subscription_status: "canceled" } }],
    })
    expect(stale.results).toEqual([{ org_id: "org_1", applied: false, reason: "stale_source" }])
    // Exact duplicate (same ts) is also a no-op.
    const dupe = await apply(store, {
      polar_customer_id: "cus_1",
      source_ts: 2000,
      source: "customer_state",
      org_states: [{ org_id: "org_1", state: PRO_STATE }],
    })
    expect(dupe.results[0]).toMatchObject({ applied: false, reason: "stale_source" })
    expect(store.rows.orgs![0]).toMatchObject({ plan: "pro", subscription_status: "active" })
  })

  test("F6: a reconciliation confirming unchanged state clears the flag and advances billing_synced_at", async () => {
    const store = db({ orgs: [orgSeed()] })
    await apply(store, {
      polar_customer_id: "cus_1",
      source_ts: 2000,
      source: "customer_state",
      org_states: [{ org_id: "org_1", state: PRO_STATE }],
    })
    // Simulate the cron having flagged the org for reconciliation, and time moving on.
    store.rows.orgs![0].billing_reconcile_flagged_at = 9999
    store.rows.orgs![0].billing_synced_at = 2000
    // The sweep re-fetches Polar and gets the SAME modified_at (2000) — equal, not newer.
    const swept = await apply(store, {
      polar_customer_id: "cus_1",
      source_ts: 2000,
      source: "reconciliation",
      org_states: [{ org_id: "org_1", state: PRO_STATE }],
    })
    // Subscription state untouched (nothing changed) but the flag MUST clear,
    // else the org is re-fetched every sweep forever.
    expect(swept.results[0]).toMatchObject({ applied: false, reason: "stale_source_reconcile_confirmed" })
    expect(store.rows.orgs![0].billing_reconcile_flagged_at).toBeUndefined()
    expect(store.rows.orgs![0].billing_synced_at).toBeGreaterThan(2000)
    expect(store.rows.orgs![0]).toMatchObject({ plan: "pro", subscription_status: "active" })
    // The same equal-timestamp payload from a NON-reconciliation source stays a plain no-op (no flag semantics).
    store.rows.orgs![0].billing_reconcile_flagged_at = 8888
    const dupe = await apply(store, {
      polar_customer_id: "cus_1",
      source_ts: 2000,
      source: "customer_state",
      org_states: [{ org_id: "org_1", state: PRO_STATE }],
    })
    expect(dupe.results[0]).toMatchObject({ applied: false, reason: "stale_source" })
    expect(store.rows.orgs![0].billing_reconcile_flagged_at).toBe(8888)
  })

  test("full-state payload downgrades a previously mirrored org absent from it; a newer subscription event re-upgrades", async () => {
    const store = db({ orgs: [orgSeed({ polar_customer_id: "cus_1", plan: "pro", subscription_status: "active", polar_state_modified_at: 1000, seats_licensed: 3 })] })
    const result = await apply(store, {
      polar_customer_id: "cus_1",
      source_ts: 2000,
      source: "customer_state",
      org_states: [],
    })
    expect(result.results).toEqual([{ org_id: "org_1", applied: true }])
    expect(store.rows.orgs![0]).toMatchObject({
      plan: "free",
      subscription_status: "none",
      polar_subscription_id: undefined,
      seats_licensed: undefined,
    })

    const upgrade = await apply(store, {
      polar_customer_id: "cus_1",
      source_ts: 3000,
      source: "subscription_event",
      org_states: [{ org_id: "org_1", state: PRO_STATE }],
    })
    expect(upgrade.results).toEqual([{ org_id: "org_1", applied: true }])
    expect(store.rows.orgs![0]).toMatchObject({ plan: "pro", seats_licensed: 3 })
  })

  test("subscription events never touch sibling orgs on the same customer", async () => {
    const store = db({
      orgs: [
        orgSeed({ _id: "org_1", polar_customer_id: "cus_1", plan: "pro", subscription_status: "active", polar_state_modified_at: 1000 }),
        orgSeed({ _id: "org_2", clerk_org_id: "clerk_org_2", polar_customer_id: "cus_1", plan: "pro", subscription_status: "active", polar_state_modified_at: 1000 }),
      ],
    })
    await apply(store, {
      polar_customer_id: "cus_1",
      source_ts: 2000,
      source: "subscription_event",
      org_states: [{ org_id: "org_1", state: { plan: "free", subscription_status: "canceled" } }],
    })
    expect(store.rows.orgs![0]).toMatchObject({ plan: "free" })
    expect(store.rows.orgs![1]).toMatchObject({ plan: "pro", subscription_status: "active" })
  })

  test("past_due carve-out: a customer-state payload without the dunning subscription keeps the past_due mirror (grace preserved)", async () => {
    const store = db({ orgs: [orgSeed({ polar_customer_id: "cus_1", plan: "pro", subscription_status: "past_due", polar_state_modified_at: 1000, seats_licensed: 3 })] })
    const result = await apply(store, {
      polar_customer_id: "cus_1",
      source_ts: 2000,
      source: "customer_state",
      org_states: [],
    })
    expect(result.results[0]).toMatchObject({ applied: false, reason: "past_due_grace_preserved" })
    expect(store.rows.orgs![0]).toMatchObject({ plan: "pro", subscription_status: "past_due", seats_licensed: 3 })

    // The EXPLICIT terminal event still downgrades — dunning genuinely over.
    await apply(store, {
      polar_customer_id: "cus_1",
      source_ts: 3000,
      source: "subscription_event",
      org_states: [{ org_id: "org_1", state: { plan: "free", subscription_status: "revoked" } }],
    })
    expect(store.rows.orgs![0]).toMatchObject({ plan: "free", subscription_status: "revoked" })
  })

  test("preserve_seats keeps the mirrored seat count when the payload omits seats", async () => {
    const store = db({ orgs: [orgSeed({ polar_customer_id: "cus_1", plan: "pro", subscription_status: "active", seats_licensed: 5, polar_state_modified_at: 1000 })] })
    await apply(store, {
      polar_customer_id: "cus_1",
      source_ts: 2000,
      source: "customer_state",
      org_states: [{ org_id: "org_1", state: { ...PRO_STATE, seats_licensed: undefined, preserve_seats: true } }],
    })
    expect(store.rows.orgs![0]).toMatchObject({ plan: "pro", seats_licensed: 5 })
  })

  test("unknown metadata.org_id is reported as unresolved, nothing thrown", async () => {
    const store = db({ orgs: [] })
    const result = await apply(store, {
      polar_customer_id: "cus_1",
      source_ts: 1000,
      source: "subscription_event",
      org_states: [{ org_id: "org_ghost", state: PRO_STATE }],
    })
    expect(result).toEqual({ results: [], unresolved: ["org_ghost"] })
  })

  test("rejects a bad service token (builder-gated)", async () => {
    const store = db({ orgs: [orgSeed()] })
    await expect(
      handler(applyPolarState)({ db: store }, {
        service_token: "wrong",
        polar_customer_id: "cus_1",
        source_ts: 1,
        source: "customer_state",
        org_states: [],
      }),
    ).rejects.toThrow("Unauthenticated")
  })
})

describe("entitlementState read model", () => {
  test("resolves by org id or clerk org id; unknown org reads as not found (free tier)", async () => {
    const store = db({ orgs: [orgSeed({ plan: "pro", subscription_status: "active", seats_licensed: 3, polar_state_modified_at: 1000, billing_synced_at: 1500 })] })
    const byOrg = await handler(entitlementState)({ db: store }, { service_token: SERVICE_TOKEN, org_id: "org_1" })
    expect(byOrg).toMatchObject({ found: true, plan: "pro", subscription_status: "active", seats_licensed: 3 })
    const byClerk = await handler(entitlementState)({ db: store }, { service_token: SERVICE_TOKEN, clerk_org_id: "clerk_org_1" })
    expect(byClerk).toMatchObject({ found: true, org_id: "org_1" })
    const missing = await handler(entitlementState)({ db: store }, { service_token: SERVICE_TOKEN, org_id: "org_ghost" })
    expect(missing).toEqual({ found: false })
  })

  test("deleted orgs read as not found (fail-closed)", async () => {
    const store = db({ orgs: [orgSeed({ plan: "pro", subscription_status: "active", deleted_at: 99 })] })
    expect(await handler(entitlementState)({ db: store }, { service_token: SERVICE_TOKEN, org_id: "org_1" }))
      .toEqual({ found: false })
  })
})

describe("seat hard-block (D6)", () => {
  const membershipEvent = (clerkSubject: string) => ({
    type: "organizationMembership.created",
    data: {
      organization: { id: "clerk_org_1", name: "Acme", updated_at: 10 },
      public_user_data: { user_id: clerkSubject },
      role: "member",
      updated_at: 10,
    },
  })

  function seatStore(input: { seats?: number; members: number }) {
    const users = [
      { _id: "user_new", clerk_subject: "clerk_user_new", token_identifier: "t_new" },
      ...Array.from({ length: input.members }, (_, index) => ({
        _id: `user_${index}`,
        clerk_subject: `clerk_user_${index}`,
        token_identifier: `t_${index}`,
      })),
    ]
    return db({
      orgs: [orgSeed(input.seats === undefined ? {} : { seats_licensed: input.seats, plan: "pro", subscription_status: "active" })],
      users: users as Row[],
      org_memberships: Array.from({ length: input.members }, (_, index) => ({
        _id: `membership_${index}`,
        org_id: "org_1",
        user_id: `user_${index}`,
        role: "member",
      })) as Row[],
    })
  }

  test("a member add UNDER the licensed seat count succeeds", async () => {
    const store = seatStore({ seats: 3, members: 2 })
    await handler(applyClerkWebhook)({ db: store }, membershipEvent("clerk_user_new"))
    expect(store.rows.org_memberships).toHaveLength(3)
  })

  test("a member add AT the licensed seat count throws the typed seat_limit_reached error", async () => {
    const store = seatStore({ seats: 3, members: 3 })
    await expect(handler(applyClerkWebhook)({ db: store }, membershipEvent("clerk_user_new")))
      .rejects.toThrow(/^seat_limit_reached/)
    expect(store.rows.org_memberships).toHaveLength(3)
  })

  test("updating an EXISTING member's role is never seat-blocked", async () => {
    const store = seatStore({ seats: 2, members: 2 })
    await handler(applyClerkWebhook)({ db: store }, {
      type: "organizationMembership.updated",
      data: {
        organization: { id: "clerk_org_1", name: "Acme", updated_at: 20 },
        public_user_data: { user_id: "clerk_user_0" },
        role: "admin",
        updated_at: 20,
      },
    })
    expect(store.rows.org_memberships!.find((row) => row.user_id === "user_0")).toMatchObject({ role: "admin" })
  })

  test("an org WITHOUT seats_licensed (free tier) accepts members — invite-before-subscribe", async () => {
    const store = seatStore({ members: 5 })
    await handler(applyClerkWebhook)({ db: store }, membershipEvent("clerk_user_new"))
    expect(store.rows.org_memberships).toHaveLength(6)
  })

  test("personal-org owner membership always bypasses the seat check", async () => {
    const store = db({ orgs: [], org_memberships: [] })
    const personalOrg = { _id: "org_p", kind: "personal", owner_user_id: "user_owner", seats_licensed: 0 }
    // Even a nonsensical zero-seat license cannot block the owner's own row.
    await expect(enforceSeatCapacity({ db: store } as never, personalOrg, "user_owner")).resolves.toBeUndefined()
    // …but the same personal org cannot take a SECOND member past its license.
    await expect(enforceSeatCapacity({ db: store } as never, personalOrg, "user_other")).rejects.toThrow(/^seat_limit_reached/)
  })
})

describe("reconciliation flagging (D5 Convex half)", () => {
  test("flags orgs with stale/absent billing_synced_at; skips fresh, already-flagged, deleted, and Polar-less orgs", async () => {
    const now = Date.now()
    const store = db({
      orgs: [
        orgSeed({ _id: "org_stale", polar_customer_id: "cus_1", billing_synced_at: now - 48 * 60 * 60 * 1000 }),
        orgSeed({ _id: "org_never_synced", clerk_org_id: "c2", polar_customer_id: "cus_2" }),
        orgSeed({ _id: "org_fresh", clerk_org_id: "c3", polar_customer_id: "cus_3", billing_synced_at: now }),
        orgSeed({ _id: "org_flagged", clerk_org_id: "c4", polar_customer_id: "cus_4", billing_reconcile_flagged_at: now }),
        orgSeed({ _id: "org_free", clerk_org_id: "c5" }),
        orgSeed({ _id: "org_deleted", clerk_org_id: "c6", polar_customer_id: "cus_6", deleted_at: 1 }),
      ],
    })
    const result = await handler(flagStaleBillingSync)({ db: store }, { stale_after_ms: 24 * 60 * 60 * 1000 })
    expect(result).toEqual({ flagged: 2 })
    const flagged = await handler(listReconcileFlagged)({ db: store }, { service_token: SERVICE_TOKEN })
    expect(flagged.map((entry: { org_id: string }) => entry.org_id).sort()).toEqual([
      "org_flagged",
      "org_never_synced",
      "org_stale",
    ])
  })
})

describe("checkoutContext", () => {
  test("reports the caller's clerk org + role when a member; falls back to the personal org as owner", async () => {
    const identity = { tokenIdentifier: "token_1", subject: "clerk_user_1", issuer: "clerk" }
    const store = db({
      orgs: [orgSeed({ plan: "pro", seats_licensed: 3, polar_customer_id: "cus_1" })],
      users: [{ _id: "user_1", clerk_subject: "clerk_user_1", token_identifier: "token_1" }],
      org_memberships: [
        { _id: "m1", org_id: "org_1", user_id: "user_1", role: "admin" },
        { _id: "m2", org_id: "org_1", user_id: "user_2", role: "member" },
      ],
    })
    const ctx = { db: store, auth: { getUserIdentity: async () => identity }, identity }
    const inOrg = await handler(checkoutContext)(ctx, { clerk_org_id: "clerk_org_1" })
    expect(inOrg).toMatchObject({ org_id: "org_1", role: "admin", member_count: 2, plan: "pro", polar_customer_id: "cus_1" })

    // No org claim → the personal org (created on first touch), role owner.
    const personal = await handler(checkoutContext)(ctx, {})
    expect(personal).toMatchObject({ role: "owner", member_count: 1 })
    expect(personal.org_id).not.toBe("org_1")
  })
})
