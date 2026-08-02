import { afterEach, describe, expect, test } from "vitest"
import { convexTest } from "convex-test"
import { api } from "./_generated/api"
import schema from "./schema"

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob("./**/*.ts")
const stamped = <T extends Record<string, unknown>>(row: T) => ({ created_at: 1, updated_at: 1, ...row })

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
 * This suite previously drove a hand-written `db` double whose `.withIndex`
 * resolved against `test-support/convex-index-harness.ts` — a second,
 * independently-maintained model of Convex's index rules. Running through
 * `convex-test` means the SAME real query engine that would reject a
 * malformed index read in production now rejects it here too.
 *
 * `membershipByClerkIds` and `resolveForMe` are covered alongside it because
 * all three shared the same prefix-only `by_org_user` read (W5.3) — one row
 * wanted, every member of the org read.
 */

const CALLER_TOKEN = "https://clerk.test|user_caller"
const OTHER_TOKEN = "https://clerk.test|user_other"
const SERVICE_TOKEN = "svc_secret"
const prevServiceToken = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN

async function seedOrgSwitchFixture(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const callerId = await ctx.db.insert("users", stamped({ token_identifier: CALLER_TOKEN, clerk_subject: "user_caller" }) as never)
    const otherId = await ctx.db.insert("users", stamped({ token_identifier: OTHER_TOKEN, clerk_subject: "user_other" }) as never)
    const acmeId = await ctx.db.insert("orgs", stamped({ clerk_org_id: "clerk_acme", name: "Acme", kind: "clerk" }) as never)
    const otherOrgId = await ctx.db.insert("orgs", stamped({ clerk_org_id: "clerk_other", name: "Other", kind: "clerk" }) as never)
    await ctx.db.insert("org_memberships", stamped({ org_id: acmeId, user_id: callerId, role: "admin" }) as never)
    // Same org, DIFFERENT user. The pre-W5 code read every one of these and
    // JS-`.find()`d the caller; the indexed read must still pick the caller's
    // row and never this one.
    await ctx.db.insert("org_memberships", stamped({ org_id: acmeId, user_id: otherId, role: "owner" }) as never)
    // Caller in a DIFFERENT org, to catch a lookup that drops the org scope.
    await ctx.db.insert("org_memberships", stamped({ org_id: otherOrgId, user_id: callerId, role: "member" }) as never)
    return { callerId, otherId, acmeId, otherOrgId }
  })
}

afterEach(() => {
  if (prevServiceToken === undefined) delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
  else process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = prevServiceToken
})

describe("orgs.setActive (W5.1 — first coverage)", () => {
  test("resolves the org by clerk id and returns the CALLER's own role", async () => {
    const t = convexTest(schema, modules)
    const { acmeId } = await seedOrgSwitchFixture(t)
    const asCaller = t.withIdentity({ tokenIdentifier: CALLER_TOKEN, subject: "user_caller" })

    // `user_other` has "owner" in the same org. Returning that role would be
    // a privilege-escalation bug, not just a wrong number.
    await expect(asCaller.query(api.orgs.setActive, { clerk_org_id: "clerk_acme" } as never))
      .resolves.toEqual({ org_id: acmeId, clerk_org_id: "clerk_acme", role: "admin" })
  })

  test("a caller in a different org gets that org's role, not their other one", async () => {
    const t = convexTest(schema, modules)
    const { otherOrgId } = await seedOrgSwitchFixture(t)
    const asCaller = t.withIdentity({ tokenIdentifier: CALLER_TOKEN, subject: "user_caller" })

    await expect(asCaller.query(api.orgs.setActive, { clerk_org_id: "clerk_other" } as never))
      .resolves.toEqual({ org_id: otherOrgId, clerk_org_id: "clerk_other", role: "member" })
  })

  test("an unknown clerk org id is 'Org not found'", async () => {
    const t = convexTest(schema, modules)
    await seedOrgSwitchFixture(t)
    const asCaller = t.withIdentity({ tokenIdentifier: CALLER_TOKEN, subject: "user_caller" })

    await expect(asCaller.query(api.orgs.setActive, { clerk_org_id: "clerk_nope" } as never))
      .rejects.toThrow("Org not found")
  })

  test("a non-member gets 'Org not found', not a membership error", async () => {
    const t = convexTest(schema, modules)
    const { acmeId, callerId } = await seedOrgSwitchFixture(t)
    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("org_memberships")
        .withIndex("by_org_user", (q) => q.eq("org_id", acmeId).eq("user_id", callerId))
        .unique()
      if (membership) await ctx.db.delete(membership._id)
    })
    const asCaller = t.withIdentity({ tokenIdentifier: CALLER_TOKEN, subject: "user_caller" })

    // Same message as the missing-org case ON PURPOSE: a distinct "you are
    // not a member" would confirm to an outsider that the org exists.
    await expect(asCaller.query(api.orgs.setActive, { clerk_org_id: "clerk_acme" } as never))
      .rejects.toThrow("Org not found")
  })

  test("an unauthenticated caller never reaches the org lookup", async () => {
    const t = convexTest(schema, modules)
    await seedOrgSwitchFixture(t)

    await expect(t.query(api.orgs.setActive, { clerk_org_id: "clerk_acme" } as never))
      .rejects.toThrow("Unauthenticated")
  })

  test("duplicate membership rows surface as an error rather than picking a winner", async () => {
    // The conversion moved from JS `.find()` (silently takes the first) to
    // `.unique()`. That is a deliberate behavior change: two rows for one
    // (org, user) is corruption, and which role wins would otherwise be
    // arbitrary — including possibly the higher one. Assert only that it
    // throws: the exact message is the real Convex query engine's, not one
    // this suite controls.
    const t = convexTest(schema, modules)
    const { acmeId, callerId } = await seedOrgSwitchFixture(t)
    await t.run(async (ctx) => {
      await ctx.db.insert("org_memberships", stamped({ org_id: acmeId, user_id: callerId, role: "owner" }) as never)
    })
    const asCaller = t.withIdentity({ tokenIdentifier: CALLER_TOKEN, subject: "user_caller" })

    await expect(asCaller.query(api.orgs.setActive, { clerk_org_id: "clerk_acme" } as never)).rejects.toThrow()
  })
})

describe("orgs membership reads are index-scoped (W5.3)", () => {
  test("membershipByClerkIds returns the named user's role, not a co-member's", async () => {
    process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = SERVICE_TOKEN
    const t = convexTest(schema, modules)
    const { acmeId } = await seedOrgSwitchFixture(t)

    await expect(t.query(api.orgs.membershipByClerkIds, {
      service_token: SERVICE_TOKEN,
      clerk_org_id: "clerk_acme",
      clerk_subject: "user_other",
    } as never)).resolves.toMatchObject({ member: true, org_id: String(acmeId), role: "owner" })
  })

  test("membershipByClerkIds reports a non-member as not a member", async () => {
    process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = SERVICE_TOKEN
    const t = convexTest(schema, modules)
    const { acmeId } = await seedOrgSwitchFixture(t)
    await t.run(async (ctx) => {
      const memberships = await ctx.db
        .query("org_memberships")
        .withIndex("by_org_user", (q) => q.eq("org_id", acmeId))
        .collect()
      for (const membership of memberships) await ctx.db.delete(membership._id)
    })

    await expect(t.query(api.orgs.membershipByClerkIds, {
      service_token: SERVICE_TOKEN,
      clerk_org_id: "clerk_acme",
      clerk_subject: "user_caller",
    } as never)).resolves.toEqual({ member: false })
  })

  test("a deleted org is not resolvable even for a real member", async () => {
    process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = SERVICE_TOKEN
    const t = convexTest(schema, modules)
    const { acmeId } = await seedOrgSwitchFixture(t)
    await t.run(async (ctx) => {
      await ctx.db.patch(acmeId, { deleted_at: 1_000 })
    })

    await expect(t.query(api.orgs.membershipByClerkIds, {
      service_token: SERVICE_TOKEN,
      clerk_org_id: "clerk_acme",
      clerk_subject: "user_caller",
    } as never)).resolves.toEqual({ member: false })
  })

  test("resolveForMe returns the caller's membership for an explicit org", async () => {
    const t = convexTest(schema, modules)
    const { acmeId } = await seedOrgSwitchFixture(t)
    const asCaller = t.withIdentity({ tokenIdentifier: CALLER_TOKEN, subject: "user_caller" })

    await expect(asCaller.mutation(api.orgs.resolveForMe, { clerk_org_id: "clerk_acme" } as never))
      .resolves.toEqual({ org_id: acmeId, clerk_org_id: "clerk_acme", role: "admin" })
  })

  test("resolveForMe refuses an org the caller is not a member of", async () => {
    const t = convexTest(schema, modules)
    const { acmeId } = await seedOrgSwitchFixture(t)
    await t.run(async (ctx) => {
      const memberships = await ctx.db
        .query("org_memberships")
        .withIndex("by_org_user", (q) => q.eq("org_id", acmeId))
        .collect()
      for (const membership of memberships) await ctx.db.delete(membership._id)
    })
    const asCaller = t.withIdentity({ tokenIdentifier: CALLER_TOKEN, subject: "user_caller" })

    await expect(asCaller.mutation(api.orgs.resolveForMe, { clerk_org_id: "clerk_acme" } as never))
      .rejects.toThrow("Organization membership is required")
  })
})
