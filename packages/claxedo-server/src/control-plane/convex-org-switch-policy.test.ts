import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { membershipByClerkIds, resolveForMe, setActive } from "../../../../convex/orgs"
import { indexRangeBuilder } from "../test-helpers/convex-index-harness"

/**
 * `orgs.setActive` — the org switch, and W5.1's headline conversion.
 *
 * These are the FIRST tests this function has ever had: it had zero coverage
 * repo-wide despite running on every org switch, which is how it kept a
 * whole-`orgs` table scan plus a JS `.find()` for a lookup that
 * `by_clerk_org_id` already served. The scan was not a slow path — past
 * Convex's per-transaction document cap it THROWS, so at scale org switching
 * breaks outright rather than degrading.
 *
 * What these assert, and — measured, not assumed — what they do not:
 *
 *  1. Results are unchanged by the conversion: the right org, the caller's own
 *     role, and "Org not found" for both the missing-org and the not-a-member
 *     cases (deliberately the same message — distinguishing them would leak the
 *     existence of an org to a non-member). This is the "behavior preserved"
 *     half, and it is what these tests are for.
 *  2. They do NOT detect a revert to the table scan. Verified by reverting
 *     `setActive` to `query("orgs").collect().find(...)`: all 11 still pass,
 *     because a scan and an indexed read return the same rows — the difference
 *     is read-set size, which no result assertion can see. `convex-unbounded-
 *     read-guard.test.ts` is what catches that (it did, naming
 *     `convex/orgs.ts:103 (setActive)`), and the two tests are complementary
 *     rather than redundant.
 *
 * The `db` double still resolves index names against the real
 * `convex/schema.ts` and enforces Convex's index-order stepping
 * (`convex-index-harness.ts`), so a query naming a nonexistent index or
 * comparing fields out of index order fails here — which is the class of
 * mistake the conversion itself could introduce.
 *
 * `membershipByClerkIds` and `resolveForMe` are covered alongside it because
 * all three shared the same prefix-only `by_org_user` read (W5.3) — one row
 * wanted, every member of the org read.
 */

type Row = Record<string, unknown> & { _id: string }

const CALLER = "https://clerk.test|user_caller"
const SERVICE_TOKEN = "svc_secret"

function db(seed: Record<string, Row[]>) {
  const rows: Record<string, Row[]> = Object.fromEntries(
    Object.entries(seed).map(([table, items]) => [table, items.map((row) => ({ ...row }))]),
  )
  return {
    rows,
    query(table: string) {
      let checks: Array<(row: Row) => boolean> = []
      const matching = () => (rows[table] ?? []).filter((row) => checks.every((check) => check(row)))
      const query = {
        withIndex(name: string, build: (q: unknown) => unknown) {
          const range = indexRangeBuilder(table, name)
          build(range.builder)
          checks = range.checks
          return query
        },
        async collect() {
          return matching()
        },
        async take(limit: number) {
          return matching().slice(0, limit)
        },
        async unique() {
          const found = matching()
          // Real Convex throws here; a double that returned found[0] would hide
          // exactly the duplicate-membership corruption `.unique()` surfaces.
          if (found.length > 1) throw new Error(`Ambiguous unique() on ${table}`)
          return found[0] ?? null
        },
        async first() {
          return matching()[0] ?? null
        },
      }
      return query
    },
    async get(id: unknown) {
      return Object.values(rows).flat().find((row) => row._id === id) ?? null
    },
    async insert(table: string, row: Record<string, unknown>) {
      const _id = `${table}_${(rows[table]?.length ?? 0) + 1}`
      rows[table] ??= []
      rows[table].push({ _id, ...row })
      return _id
    },
    async patch(id: unknown, patch: Record<string, unknown>) {
      const row = Object.values(rows).flat().find((item) => item._id === id)
      if (!row) throw new Error(`Missing row ${String(id)}`)
      Object.assign(row, patch)
    },
  }
}

function handler(fn: unknown) {
  return (fn as { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<any> })._handler
}

/** `authedQuery` resolves the caller through `requireIdentity` off `ctx.auth`. */
function ctx(store: ReturnType<typeof db>, tokenIdentifier = CALLER) {
  return {
    db: store,
    auth: {
      getUserIdentity: async () => ({
        tokenIdentifier,
        subject: tokenIdentifier.split("|")[1],
        issuer: "https://clerk.test",
      }),
    },
  }
}

function store() {
  return db({
    users: [
      { _id: "user_caller", token_identifier: CALLER, clerk_subject: "user_caller" },
      { _id: "user_other", token_identifier: "https://clerk.test|user_other", clerk_subject: "user_other" },
    ],
    orgs: [
      { _id: "org_acme", clerk_org_id: "clerk_acme", name: "Acme", kind: "clerk" },
      { _id: "org_other", clerk_org_id: "clerk_other", name: "Other", kind: "clerk" },
    ],
    org_memberships: [
      { _id: "mem_1", org_id: "org_acme", user_id: "user_caller", role: "admin" },
      // Same org, DIFFERENT user. The pre-W5 code read every one of these and
      // JS-`.find()`d the caller; the indexed read must still pick the caller's
      // row and never this one.
      { _id: "mem_2", org_id: "org_acme", user_id: "user_other", role: "owner" },
      // Caller in a DIFFERENT org, to catch a lookup that drops the org scope.
      { _id: "mem_3", org_id: "org_other", user_id: "user_caller", role: "member" },
    ],
  })
}

const previousIssuer = process.env.CLERK_JWT_ISSUER_DOMAIN
const previousToken = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN

beforeEach(() => {
  process.env.CLERK_JWT_ISSUER_DOMAIN = "https://clerk.test"
  // Set explicitly rather than read from the ambient environment: these
  // service-token reads must pass on a clean shell, and a test that silently
  // depends on an exported var passes locally and fails in CI.
  process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = SERVICE_TOKEN
})

afterEach(() => {
  if (previousIssuer === undefined) delete process.env.CLERK_JWT_ISSUER_DOMAIN
  else process.env.CLERK_JWT_ISSUER_DOMAIN = previousIssuer
  if (previousToken === undefined) delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
  else process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = previousToken
})

describe("orgs.setActive (W5.1 — first coverage)", () => {
  test("resolves the org by clerk id and returns the CALLER's own role", async () => {
    // `mem_2` gives another user "owner" in the same org. Returning that role
    // would be a privilege-escalation bug, not just a wrong number.
    await expect(handler(setActive)(ctx(store()), { clerk_org_id: "clerk_acme" }))
      .resolves.toEqual({ org_id: "org_acme", clerk_org_id: "clerk_acme", role: "admin" })
  })

  test("a caller in a different org gets that org's role, not their other one", async () => {
    await expect(handler(setActive)(ctx(store()), { clerk_org_id: "clerk_other" }))
      .resolves.toEqual({ org_id: "org_other", clerk_org_id: "clerk_other", role: "member" })
  })

  test("an unknown clerk org id is 'Org not found'", async () => {
    await expect(handler(setActive)(ctx(store()), { clerk_org_id: "clerk_nope" }))
      .rejects.toThrow("Org not found")
  })

  test("a non-member gets 'Org not found', not a membership error", async () => {
    // Same message as the missing-org case ON PURPOSE: a distinct "you are not
    // a member" would confirm to an outsider that the org exists.
    const state = store()
    state.rows.org_memberships = state.rows.org_memberships!.filter((row) => row._id !== "mem_1")

    await expect(handler(setActive)(ctx(state), { clerk_org_id: "clerk_acme" }))
      .rejects.toThrow("Org not found")
  })

  test("an unauthenticated caller never reaches the org lookup", async () => {
    const state = store()
    const unauthenticated = {
      db: state,
      auth: { getUserIdentity: async () => null },
    }
    await expect(handler(setActive)(unauthenticated, { clerk_org_id: "clerk_acme" }))
      .rejects.toThrow("Unauthenticated")
  })

  test("duplicate membership rows surface as an error rather than picking a winner", async () => {
    // The conversion moved from JS `.find()` (silently takes the first) to
    // `.unique()`. That is a deliberate behavior change: two rows for one
    // (org, user) is corruption, and which role wins would otherwise be
    // arbitrary — including possibly the higher one.
    const state = store()
    state.rows.org_memberships!.push({ _id: "mem_dupe", org_id: "org_acme", user_id: "user_caller", role: "owner" })

    await expect(handler(setActive)(ctx(state), { clerk_org_id: "clerk_acme" }))
      .rejects.toThrow(/Ambiguous unique/)
  })
})

describe("orgs membership reads are index-scoped (W5.3)", () => {
  test("membershipByClerkIds returns the named user's role, not a co-member's", async () => {
    await expect(handler(membershipByClerkIds)(ctx(store()), {
      service_token: SERVICE_TOKEN,
      clerk_org_id: "clerk_acme",
      clerk_subject: "user_other",
    })).resolves.toMatchObject({ member: true, org_id: "org_acme", role: "owner" })
  })

  test("membershipByClerkIds reports a non-member as not a member", async () => {
    const state = store()
    state.rows.org_memberships = state.rows.org_memberships!.filter((row) => row.org_id !== "org_acme")

    await expect(handler(membershipByClerkIds)(ctx(state), {
      service_token: SERVICE_TOKEN,
      clerk_org_id: "clerk_acme",
      clerk_subject: "user_caller",
    })).resolves.toEqual({ member: false })
  })

  test("a deleted org is not resolvable even for a real member", async () => {
    const state = store()
    state.rows.orgs!.find((row) => row._id === "org_acme")!.deleted_at = 1_000

    await expect(handler(membershipByClerkIds)(ctx(state), {
      service_token: SERVICE_TOKEN,
      clerk_org_id: "clerk_acme",
      clerk_subject: "user_caller",
    })).resolves.toEqual({ member: false })
  })

  test("resolveForMe returns the caller's membership for an explicit org", async () => {
    await expect(handler(resolveForMe)(ctx(store()), { clerk_org_id: "clerk_acme" }))
      .resolves.toEqual({ org_id: "org_acme", clerk_org_id: "clerk_acme", role: "admin" })
  })

  test("resolveForMe refuses an org the caller is not a member of", async () => {
    const state = store()
    state.rows.org_memberships = state.rows.org_memberships!.filter((row) => row.org_id !== "org_acme")

    await expect(handler(resolveForMe)(ctx(state), { clerk_org_id: "clerk_acme" }))
      .rejects.toThrow("Organization membership is required")
  })
})
