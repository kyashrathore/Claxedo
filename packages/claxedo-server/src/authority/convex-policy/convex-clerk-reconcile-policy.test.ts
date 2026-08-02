import { getFunctionName } from "convex/server"
import { describe, expect, test } from "vitest"
import {
  CLERK_LIVENESS_ORG_PROBE,
  CLERK_MEMBERSHIP_PAGE_SIZE,
  CLERK_SWEEP_ORG_CAP,
  CLERK_TOMBSTONE_RETAIN_MS,
  ClerkRateLimited,
  applyReconcileCorrections,
  fetchClerkMemberships,
  flagStaleClerkWebhooks,
  listOrgMemberships,
  listOrgsToSweep,
  reapMembershipTombstones,
  readSweepCursor,
  recordSweepRun,
  reconcileMemberships,
  runClerkSweep,
  type ClerkClient,
  type ClerkMembership,
} from "../../../../../convex/clerkReconcile"
import { applyClerkWebhook } from "../../../../../convex/orgs"
import { indexRangeBuilder, orderByIndex, type Row } from "../../test-support/convex-index-harness"

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
 * Every assertion here was run against pre-fix code first and shown to FAIL;
 * the failure output is recorded in the W6.3 report. A green test nobody has
 * seen red is a claim, not a control.
 */

// ---------------------------------------------------------------------------
// The db double. Index-faithful (`convex-index-harness`), so a query naming an
// index that does not exist, or stepping range fields out of index order,
// FAILS rather than quietly behaving like a field filter — the blind spot that
// let three missing `by_tenant` indexes ship.
// ---------------------------------------------------------------------------

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
      let checks: Array<(row: Row) => boolean> = []
      let index: string | undefined
      const query = {
        withIndex(name: string, build: (q: unknown) => unknown) {
          const range = indexRangeBuilder(table, name)
          build(range.builder)
          checks = range.checks
          index = name
          return query
        },
        async collect() {
          const matched = (rows[table] ?? []).filter((row) => checks.every((check) => check(row)))
          // Index order, not seed order. The sweep's round-robin cursor is only
          // a real "next page" if the scan is ordered, so a double that returned
          // seed order would pass the coverage test while proving nothing.
          return index ? orderByIndex(matched, table, index) : matched
        },
        async take(limit: number) {
          return (await query.collect()).slice(0, limit)
        },
        async unique() {
          const matched = await query.collect()
          if (matched.length > 1) throw new Error(`unique() matched ${matched.length} rows in ${table}`)
          return matched[0] ?? null
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
  return (fn as { _handler: (ctx: any, args: Record<string, unknown>) => Promise<any> })._handler
}

/**
 * An action ctx over one store: routes `runQuery`/`runMutation` to the right
 * handler by the function reference's own name.
 *
 * Each call gets a FRESH handler invocation, which is what makes the
 * re-derivation in `applyReconcileCorrections` meaningful — an action and its
 * corrective mutation genuinely are separate transactions in Convex, and a
 * double that shared one call would hide every stale-read bug.
 */
function actionCtx(store: ReturnType<typeof db>) {
  const registry = new Map<string, unknown>([
    ["listOrgsToSweep", listOrgsToSweep],
    ["listOrgMemberships", listOrgMemberships],
    ["applyReconcileCorrections", applyReconcileCorrections],
    ["recordSweepRun", recordSweepRun],
    ["readSweepCursor", readSweepCursor],
  ])
  const dispatch = async (reference: any, args: Record<string, unknown>) => {
    // `getFunctionName` is Convex's own accessor for a function reference's UDF
    // path (`"clerkReconcile:listOrgsToSweep"`), which is how the real runtime
    // resolves these too. Reading it rather than stringifying the proxy matters:
    // `anyApi` proxies throw on primitive coercion.
    const path = getFunctionName(reference)
    const name = path.split(":").pop()!
    const fn = registry.get(name)
    if (!fn) throw new Error(`Unrouted function reference: ${path}`)
    return await handler(fn)({ db: store }, args)
  }
  return { runQuery: dispatch, runMutation: dispatch }
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

const WEBHOOK_SEEN = { _id: "sync_1", scope: "clerk", created_at: 1, updated_at: 1 }

/**
 * Org + user + membership, the shape every divergence test starts from.
 *
 * The return type is annotated as plain `Row[]` tables rather than inferred:
 * inference narrows each seed row to its own literal shape, so a test that adds
 * a field (`deleted_at`) or pushes a differently-shaped row is rejected for no
 * real reason — these are hand-built doubles, and the schema is checked by the
 * index harness, not by these literals.
 */
function orgSeed(input: { role?: string; clerkUpdatedAt?: number } = {}): Record<string, Row[]> {
  return {
    orgs: [{ _id: "org_1", clerk_org_id: "clerk_org_1", kind: "clerk", name: "Acme", created_at: 1, updated_at: 1 }],
    users: [{ _id: "user_1", clerk_subject: "clerk_user_1", token_identifier: "clerk:clerk_user_1", created_at: 1, updated_at: 1 }],
    org_memberships: [{
      _id: "membership_1",
      org_id: "org_1",
      user_id: "user_1",
      role: input.role ?? "admin",
      clerk_updated_at: input.clerkUpdatedAt,
      created_at: 1,
      updated_at: 1,
    }],
    clerk_membership_tombstones: [],
    clerk_sync_state: [],
    audit_events: [],
  }
}

// ===========================================================================
// The pure diff.
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
// Divergence correction end-to-end, through the real action.
// ===========================================================================

describe("the sweep corrects a seeded divergence within one cycle (W6.3 DoD)", () => {
  test("membership in Convex, absent from Clerk: revoked, tombstoned, audited", async () => {
    const store = db(orgSeed())
    const { client } = fakeClerk({ clerk_org_1: [] })

    const result = await runClerkSweep({ ctx: actionCtx(store), client, limit: 10, now: 9_000 })

    expect(result).toMatchObject({ orgs: 1, corrections: 1, rate_limited: false })
    // The access is actually gone — not merely reported.
    expect(store.rows.org_memberships).toEqual([])
    // Tombstoned at the OBSERVATION instant, so a late `.created` older than
    // this sweep loses.
    expect(store.rows.clerk_membership_tombstones).toEqual([
      expect.objectContaining({
        clerk_org_id: "clerk_org_1",
        clerk_subject: "clerk_user_1",
        clerk_updated_at: 9_000,
        source: "sweep",
      }),
    ])
    // The audit event the DoD names, attributed to the SWEEP so an operator can
    // tell a reconciliation from a webhook.
    expect(store.rows.audit_events).toEqual([
      expect.objectContaining({
        action: "org.membership.revoked",
        org_id: "org_1",
        user_id: "user_1",
        metadata: expect.objectContaining({ source: "sweep", revoked_role: "admin" }),
      }),
    ])
  })

  test("membership in Clerk, missing in Convex: inserted with an audit event", async () => {
    const seed = orgSeed()
    seed.org_memberships = []
    const store = db(seed)
    const { client } = fakeClerk({
      clerk_org_1: [{ clerk_subject: "clerk_user_1", role: "org:admin", updated_at: 5_000 }],
    })

    const result = await runClerkSweep({ ctx: actionCtx(store), client, limit: 10, now: 9_000 })

    expect(result).toMatchObject({ orgs: 1, corrections: 1 })
    expect(store.rows.org_memberships).toEqual([
      expect.objectContaining({ org_id: "org_1", user_id: "user_1", role: "admin", clerk_updated_at: 5_000 }),
    ])
    expect(store.rows.audit_events).toEqual([
      expect.objectContaining({
        action: "org.membership.restored",
        metadata: expect.objectContaining({ source: "sweep", granted_role: "admin" }),
      }),
    ])
  })

  test("a drifted role is corrected and audited", async () => {
    const store = db(orgSeed({ role: "admin" }))
    const { client } = fakeClerk({
      clerk_org_1: [{ clerk_subject: "clerk_user_1", role: "org:member", updated_at: 5_000 }],
    })

    await runClerkSweep({ ctx: actionCtx(store), client, limit: 10, now: 9_000 })

    expect(store.rows.org_memberships[0]).toMatchObject({ role: "member" })
    expect(store.rows.audit_events[0]).toMatchObject({
      action: "org.membership.role_corrected",
      metadata: expect.objectContaining({ previous_role: "admin", corrected_role: "member" }),
    })
  })

  test("an agreeing org is left completely alone", async () => {
    // Guards against the reaper-that-destroys-everything failure: the tests
    // above are all satisfiable by a sweep that revokes unconditionally.
    const store = db(orgSeed({ role: "admin" }))
    const { client } = fakeClerk({
      clerk_org_1: [{ clerk_subject: "clerk_user_1", role: "org:admin", updated_at: 5_000 }],
    })

    const result = await runClerkSweep({ ctx: actionCtx(store), client, limit: 10, now: 9_000 })

    expect(result).toMatchObject({ orgs: 1, corrections: 0 })
    expect(store.rows.org_memberships).toHaveLength(1)
    expect(store.rows.audit_events).toEqual([])
  })

  test("a truncated Clerk read corrects NOTHING for that org", async () => {
    // End-to-end proof of the refusal: the org has two members, Clerk pages
    // forever, and no revocation is written.
    const seed = orgSeed()
    seed.users.push({
      _id: "user_2",
      clerk_subject: "clerk_user_2",
      token_identifier: "clerk:clerk_user_2",
      created_at: 1,
      updated_at: 1,
    } as Row)
    seed.org_memberships.push({
      _id: "membership_2",
      org_id: "org_1",
      user_id: "user_2",
      role: "member",
      created_at: 1,
      updated_at: 1,
    } as Row)
    const store = db(seed)
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

    const result = await runClerkSweep({ ctx: actionCtx(store), client, limit: 10, now: 9_000 })

    expect(result).toMatchObject({ corrections: 0 })
    expect(store.rows.org_memberships).toHaveLength(2)
    expect(store.rows.audit_events).toEqual([])
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
    const store = db(orgSeed({ clerkUpdatedAt: 1_000 }))

    await handler(applyClerkWebhook)({ db: store }, deleteEvent(2_000))
    expect(store.rows.org_memberships).toEqual([])

    // The redelivery: an OLDER event arriving later.
    await handler(applyClerkWebhook)({ db: store }, createEvent(1_000))

    expect(store.rows.org_memberships).toEqual([])
  })

  test("a create bearing the SAME timestamp as the revocation is also dropped", async () => {
    // The `>=` boundary. Clerk timestamps are coarse enough for a delete and a
    // redelivered create to share one, and a `>` comparison would admit it —
    // reopening the hole for exactly the ambiguous case.
    const store = db(orgSeed({ clerkUpdatedAt: 1_000 }))
    await handler(applyClerkWebhook)({ db: store }, deleteEvent(2_000))
    await handler(applyClerkWebhook)({ db: store }, createEvent(2_000))
    expect(store.rows.org_memberships).toEqual([])
  })

  test("a GENUINE later re-join still succeeds and retires the tombstone", async () => {
    // The guard must not become a permanent ban — otherwise removing someone
    // from an org would lock them out of ever rejoining it, which is a worse
    // bug than the one being fixed. This is what makes the guard a timestamp
    // comparison rather than a blocklist.
    const store = db(orgSeed({ clerkUpdatedAt: 1_000 }))
    await handler(applyClerkWebhook)({ db: store }, deleteEvent(2_000))

    await handler(applyClerkWebhook)({ db: store }, createEvent(3_000))

    expect(store.rows.org_memberships).toEqual([
      expect.objectContaining({ org_id: "org_1", user_id: "user_1", role: "admin", clerk_updated_at: 3_000 }),
    ])
    // Retired, not left behind: a stale tombstone would make the NEXT
    // revoke-then-rejoin cycle compare against the wrong (older) revocation.
    expect(store.rows.clerk_membership_tombstones).toEqual([])
  })

  test("the delete path tombstones even when the membership row is not there yet", async () => {
    // Svix does not guarantee order, so `.deleted` before `.created` is a real
    // arrival pattern — and it is exactly the one with nothing to delete. A
    // tombstone written only when a row existed would skip it and the following
    // create would win.
    const seed = orgSeed()
    seed.org_memberships = []
    const store = db(seed)

    await handler(applyClerkWebhook)({ db: store }, deleteEvent(2_000))
    expect(store.rows.clerk_membership_tombstones).toHaveLength(1)

    await handler(applyClerkWebhook)({ db: store }, createEvent(1_000))
    expect(store.rows.org_memberships).toEqual([])
  })

  test("an out-of-order pair of deletes keeps the NEWEST revocation", async () => {
    // An older `.deleted` arriving late must not lower the bar a subsequent
    // late `.created` has to clear.
    const store = db(orgSeed({ clerkUpdatedAt: 1_000 }))
    await handler(applyClerkWebhook)({ db: store }, deleteEvent(5_000))
    await handler(applyClerkWebhook)({ db: store }, deleteEvent(2_000))
    expect(store.rows.clerk_membership_tombstones[0]).toMatchObject({ clerk_updated_at: 5_000 })
    // A create between the two timestamps still loses.
    await handler(applyClerkWebhook)({ db: store }, createEvent(3_000))
    expect(store.rows.org_memberships).toEqual([])
  })

  test("the webhook delete path writes an audit event", async () => {
    // The positive control for gap (a): pre-fix `deleteClerkMembership` wrote
    // NO audit record, making the most security-relevant event in the mirror
    // invisible after the fact.
    const store = db(orgSeed({ clerkUpdatedAt: 1_000 }))
    await handler(applyClerkWebhook)({ db: store }, deleteEvent(2_000))
    expect(store.rows.audit_events).toEqual([
      expect.objectContaining({
        action: "org.membership.revoked",
        org_id: "org_1",
        user_id: "user_1",
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
    const store = db(orgSeed({ clerkUpdatedAt: 1_000 }))
    const { client } = fakeClerk({ clerk_org_1: [] })
    await runClerkSweep({ ctx: actionCtx(store), client, limit: 10, now: 9_000 })
    expect(store.rows.org_memberships).toEqual([])

    await handler(applyClerkWebhook)({ db: store }, createEvent(8_000))

    expect(store.rows.org_memberships).toEqual([])
  })

  test("the sweep's INSERT respects a newer tombstone", async () => {
    // The mirror image: Clerk reports a membership the sweep is missing, but a
    // revocation was observed AFTER the timestamp Clerk reports — so Clerk's
    // row is the stale side and inserting it would resurrect revoked access.
    const seed = orgSeed()
    seed.org_memberships = []
    seed.clerk_membership_tombstones = [{
      _id: "tomb_1",
      clerk_org_id: "clerk_org_1",
      clerk_subject: "clerk_user_1",
      clerk_updated_at: 8_000,
      source: "webhook",
      created_at: 8_000,
    } as Row]
    const store = db(seed)
    const { client } = fakeClerk({
      clerk_org_1: [{ clerk_subject: "clerk_user_1", role: "org:admin", updated_at: 5_000 }],
    })

    const result = await runClerkSweep({ ctx: actionCtx(store), client, limit: 10, now: 9_000 })

    expect(result).toMatchObject({ corrections: 0 })
    expect(store.rows.org_memberships).toEqual([])
  })
})

// ===========================================================================
// Bounds: org cap, coverage, and 429 backoff.
// ===========================================================================

describe("the sweep respects its bounds (W6.3 DoD)", () => {
  function manyOrgs(count: number) {
    return {
      orgs: Array.from({ length: count }, (_, index) => ({
        _id: `org_${index}`,
        // Zero-padded so string order matches numeric order — the cursor is a
        // position in the `by_clerk_org_id` index, which orders lexically.
        clerk_org_id: `clerk_org_${String(index).padStart(3, "0")}`,
        kind: "clerk",
        name: `Org ${index}`,
        created_at: 1,
        updated_at: 1,
      })) as Row[],
      users: [] as Row[],
      org_memberships: [] as Row[],
      clerk_membership_tombstones: [] as Row[],
      clerk_sync_state: [] as Row[],
      audit_events: [] as Row[],
    }
  }

  test("a run examines at most the org cap, and never more than CLERK_SWEEP_ORG_CAP", async () => {
    const store = db(manyOrgs(20))
    const { client, requests } = fakeClerk({})

    const result = await runClerkSweep({ ctx: actionCtx(store), client, limit: 5, now: 9_000 })

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
    const store = db(manyOrgs(7))
    const { client, requests } = fakeClerk({})
    const ctx = actionCtx(store)

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
    const store = db(manyOrgs(10))
    const { client, requests } = fakeClerk({}, {
      failWith: (_org, count) => (count === 3 ? new ClerkRateLimited(30) : undefined),
    })

    const result = await runClerkSweep({ ctx: actionCtx(store), client, limit: 10, now: 9_000 })

    expect(result).toMatchObject({ rate_limited: true, orgs: 2 })
    // Stopped, not skipped past: exactly the three attempts, then nothing.
    expect(requests).toHaveLength(3)
    // The cursor is the last FULLY SWEPT org, so the next run resumes at the
    // org this one was refused on rather than skipping it.
    expect(result.cursor).toBe("clerk_org_001")
    expect(store.rows.clerk_sync_state[0]).toMatchObject({
      sweep_cursor: "clerk_org_001",
      last_sweep_rate_limited_at: 9_000,
    })
  })

  test("a 429 on the very first org keeps the incoming cursor rather than rewinding", async () => {
    // Committing `undefined` here would rewind the round-robin to the start of
    // the table on every rate-limited run, so orgs late in the index would
    // never be reached.
    const store = db(manyOrgs(10))
    const { client } = fakeClerk({}, { failWith: () => new ClerkRateLimited(30) })

    const result = await runClerkSweep({
      ctx: actionCtx(store),
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
    const store = db(manyOrgs(4))
    const { client, requests } = fakeClerk({}, {
      failWith: (_org, count) => (count === 2 ? new Error("Clerk membership read failed: 503") : undefined),
    })

    const result = await runClerkSweep({ ctx: actionCtx(store), client, limit: 4, now: 9_000 })

    expect(requests).toHaveLength(4)
    expect(result).toMatchObject({ rate_limited: false, orgs: 3 })
  })

  test("personal orgs and deleted orgs are never swept", async () => {
    // A personal org has no `clerk_org_id`, so asking Clerk about it is
    // meaningless — and a diff against an empty Clerk response would revoke the
    // owner's own membership in the one org every user has.
    const store = db({
      orgs: [
        { _id: "personal_1", kind: "personal", owner_user_id: "user_1", name: "Personal", created_at: 1, updated_at: 1 },
        { _id: "org_1", clerk_org_id: "clerk_org_1", kind: "clerk", name: "Acme", created_at: 1, updated_at: 1 },
        { _id: "org_2", clerk_org_id: "clerk_org_2", kind: "clerk", name: "Gone", deleted_at: 5, created_at: 1, updated_at: 1 },
      ],
      users: [],
      org_memberships: [],
      clerk_membership_tombstones: [],
      clerk_sync_state: [],
      audit_events: [],
    })
    const { client, requests } = fakeClerk({})

    await runClerkSweep({ ctx: actionCtx(store), client, limit: 10, now: 9_000 })

    expect(requests.map((request) => request.clerkOrgId)).toEqual(["clerk_org_1"])
  })
})

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
  const apply = (store: ReturnType<typeof db>, corrections: unknown[]) =>
    handler(applyReconcileCorrections)({ db: store }, {
      clerk_org_id: "clerk_org_1",
      observed_at: 9_000,
      corrections,
    })

  test("a revoke naming a membership id that no longer matches is SKIPPED", async () => {
    // The action read its rows in an earlier transaction. If a webhook has
    // re-created the membership since, that is a NEWER fact than this sweep's
    // observation and must survive it — trusting a stale `membership_id` is
    // exactly how a sweep deletes the wrong row.
    const store = db(orgSeed())
    const result = await apply(store, [
      { kind: "revoke", membership_id: "membership_STALE", clerk_subject: "clerk_user_1", role: "admin" },
    ])
    expect(result).toEqual({ applied: 0, skipped: 1 })
    expect(store.rows.org_memberships).toHaveLength(1)
  })

  test("a role correction whose `from` no longer holds is SKIPPED", async () => {
    const store = db(orgSeed({ role: "member" }))
    const result = await apply(store, [{
      kind: "role",
      membership_id: "membership_1",
      clerk_subject: "clerk_user_1",
      from: "admin",
      to: "member",
    }])
    expect(result).toEqual({ applied: 0, skipped: 1 })
  })

  test("an insert for an existing membership is SKIPPED, not duplicated", async () => {
    const store = db(orgSeed())
    const result = await apply(store, [
      { kind: "insert", clerk_subject: "clerk_user_1", role: "admin", clerk_updated_at: 5_000 },
    ])
    expect(result).toEqual({ applied: 0, skipped: 1 })
    expect(store.rows.org_memberships).toHaveLength(1)
  })

  test("nothing is written for an org deleted since the read", async () => {
    const seed = orgSeed()
    seed.orgs[0]!.deleted_at = 8_000
    const store = db(seed)
    const result = await apply(store, [
      { kind: "revoke", membership_id: "membership_1", clerk_subject: "clerk_user_1", role: "admin" },
    ])
    expect(result).toMatchObject({ applied: 0 })
    expect(store.rows.org_memberships).toHaveLength(1)
  })

  test("a correction for a user with no Convex row is SKIPPED", async () => {
    const seed = orgSeed()
    seed.users = []
    const store = db(seed)
    const result = await apply(store, [
      { kind: "insert", clerk_subject: "clerk_ghost", role: "admin", clerk_updated_at: 5_000 },
    ])
    expect(result).toEqual({ applied: 0, skipped: 1 })
    expect(store.rows.org_memberships).toHaveLength(1)
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
    const now = Date.now()
    const store = db({
      clerk_membership_tombstones: [
        { _id: "old", clerk_org_id: "o", clerk_subject: "a", clerk_updated_at: 1, source: "webhook", created_at: now - 40 * 24 * 60 * 60 * 1_000 },
        { _id: "fresh", clerk_org_id: "o", clerk_subject: "b", clerk_updated_at: 1, source: "webhook", created_at: now - 60_000 },
      ],
    })

    const result = await handler(reapMembershipTombstones)({ db: store }, {
      retain_ms: CLERK_TOMBSTONE_RETAIN_MS,
      limit: 100,
    })

    expect(result).toEqual({ deleted: 1 })
    expect(store.rows.clerk_membership_tombstones.map((row) => row._id)).toEqual(["fresh"])
  })
})

// ===========================================================================
// Webhook liveness.
// ===========================================================================

describe("webhook-liveness flag (W6.3 item 4)", () => {
  const flag = (store: ReturnType<typeof db>, now: number) =>
    handler(flagStaleClerkWebhooks)({ db: store }, { stale_after_ms: 24 * 60 * 60 * 1_000, now })

  const liveOrg = {
    _id: "org_1",
    clerk_org_id: "clerk_org_1",
    kind: "clerk",
    name: "Acme",
    created_at: 1,
    updated_at: 1,
  } as Row

  test("a silent channel with live Clerk orgs is FLAGGED", async () => {
    // Svix disables an endpoint after 5 days of failed deliveries, which stops
    // every event type at once and is otherwise completely silent.
    const now = 100 * 60 * 60 * 1_000
    const store = db({
      orgs: [liveOrg],
      clerk_sync_state: [{ ...WEBHOOK_SEEN, last_webhook_at: now - 48 * 60 * 60 * 1_000 } as Row],
    })
    const result = await flag(store, now)
    expect(result).toMatchObject({ flagged: true, reason: "stale" })
    expect(store.rows.clerk_sync_state[0]).toMatchObject({ webhook_stale_flagged_at: now })
  })

  test("a recent webhook is not flagged", async () => {
    const now = 100 * 60 * 60 * 1_000
    const store = db({
      orgs: [liveOrg],
      clerk_sync_state: [{ ...WEBHOOK_SEEN, last_webhook_at: now - 60_000 } as Row],
    })
    expect(await flag(store, now)).toMatchObject({ flagged: false, reason: "fresh" })
  })

  test("a deployment with no live Clerk orgs is not flagged", async () => {
    // Otherwise the flag would be permanently lit on every fresh and
    // self-hosted deployment, which is how a signal becomes noise.
    const now = 100 * 60 * 60 * 1_000
    const store = db({
      orgs: [{ _id: "personal_1", kind: "personal", name: "Personal", created_at: 1, updated_at: 1 } as Row],
      clerk_sync_state: [{ ...WEBHOOK_SEEN, last_webhook_at: now - 48 * 60 * 60 * 1_000 } as Row],
    })
    expect(await flag(store, now)).toMatchObject({ flagged: false, reason: "no_clerk_orgs" })
  })

  test("orgs deleted at the head of the index do not mask a live org", async () => {
    // The liveness probe reads a bounded window and filters `deleted_at` in JS,
    // so a run of deleted orgs must not read as "no Clerk orgs" — that would
    // silence the flag on exactly the deployments old enough to have churn.
    const now = 100 * 60 * 60 * 1_000
    const deleted = Array.from({ length: 5 }, (_, index) => ({
      _id: `dead_${index}`,
      clerk_org_id: `clerk_org_00${index}`,
      kind: "clerk",
      name: "Gone",
      deleted_at: 5,
      created_at: 1,
      updated_at: 1,
    })) as Row[]
    const store = db({
      orgs: [...deleted, { ...liveOrg, clerk_org_id: "clerk_org_zzz" } as Row],
      clerk_sync_state: [{ ...WEBHOOK_SEEN, last_webhook_at: now - 48 * 60 * 60 * 1_000 } as Row],
    })
    expect(await flag(store, now)).toMatchObject({ flagged: true })
    expect(CLERK_LIVENESS_ORG_PROBE).toBeGreaterThan(deleted.length)
  })

  test("a deployment that has never seen a webhook is not flagged", async () => {
    const store = db({ orgs: [liveOrg], clerk_sync_state: [] })
    expect(await flag(store, 1_000)).toMatchObject({ flagged: false, reason: "never_seen" })
  })

  test("the flag does not re-fire while already set", async () => {
    const now = 100 * 60 * 60 * 1_000
    const store = db({
      orgs: [liveOrg],
      clerk_sync_state: [{ ...WEBHOOK_SEEN, last_webhook_at: now - 48 * 60 * 60 * 1_000, webhook_stale_flagged_at: now - 1_000 } as Row],
    })
    expect(await flag(store, now)).toMatchObject({ flagged: false, reason: "already_flagged" })
  })

  test("ANY verified webhook stamps liveness and CLEARS the flag", async () => {
    // Self-clearing, exactly like billing's `billing_reconcile_flagged_at`: a
    // flag an operator must clear by hand stays lit after the incident and
    // stops meaning anything.
    //
    // "Any type" is deliberate — an unhandled event type proves the channel is
    // delivering just as well as a handled one, and the question this answers is
    // whether the channel is alive at all.
    const store = db({
      orgs: [],
      users: [],
      org_memberships: [],
      clerk_membership_tombstones: [],
      audit_events: [],
      clerk_sync_state: [{ ...WEBHOOK_SEEN, last_webhook_at: 1_000, webhook_stale_flagged_at: 5_000 } as Row],
    })

    await handler(applyClerkWebhook)({ db: store }, { type: "session.created", data: {} })

    expect(store.rows.clerk_sync_state[0]).toMatchObject({
      last_webhook_type: "session.created",
      webhook_stale_flagged_at: undefined,
    })
    expect(store.rows.clerk_sync_state[0]!.last_webhook_at).toBeGreaterThan(1_000)
  })
})
