import { describe, expect, test } from "vitest"
import { convexTest } from "convex-test"
import { api, internal } from "./_generated/api"
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
 * Org/tenancy policy for the Clerk-backed webhook applier and org resolution.
 *
 * These run against the real function pipeline via `convex-test` — including
 * the `authedMutation`/`webhookMutation` wrappers from `model.ts`, which is
 * where identity is required and internal-vs-public visibility is decided.
 * The previous version of this suite lived in claxedo-server, imported these
 * modules across five directory levels, reached past the builders into
 * `_handler`, and drove a hand-written `db` double — so it exercised the
 * handler bodies while skipping the auth wrappers that make them safe.
 */
describe("Convex org webhook policy", () => {
  test("organizationMembership.deleted removes the matching org membership", async () => {
    const t = convexTest(schema, modules)

    await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("orgs", stamped({ clerk_org_id: "clerk_org_1", kind: "clerk", name: "Acme" }) as never)
      const userId = await ctx.db.insert("users", stamped({ clerk_subject: "clerk_user_1", token_identifier: "token_1" }) as never)
      await ctx.db.insert("org_memberships", stamped({ org_id: orgId, user_id: userId, role: "member" }) as never)
    })

    await t.mutation(internal.orgs.applyClerkWebhook, {
      type: "organizationMembership.deleted",
      data: {
        organization: { id: "clerk_org_1" },
        public_user_data: { user_id: "clerk_user_1" },
      },
    } as never)

    const remaining = await t.run(async (ctx) => ctx.db.query("org_memberships").collect())
    expect(remaining).toEqual([])
  })

  test("resolves an explicit Clerk organization only through a durable membership", async () => {
    const t = convexTest(schema, modules)

    await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("orgs", stamped({ clerk_org_id: "clerk_org_1", kind: "clerk", name: "Acme" }) as never)
      const userId = await ctx.db.insert("users", stamped({ token_identifier: "clerk|user_1", clerk_subject: "user_1" }) as never)
      await ctx.db.insert("org_memberships", stamped({ org_id: orgId, user_id: userId, role: "member" }) as never)
    })

    const asUser = t.withIdentity({ tokenIdentifier: "clerk|user_1", subject: "user_1" })
    await expect(asUser.mutation(api.orgs.resolveForMe, { clerk_org_id: "clerk_org_1" } as never))
      .resolves.toMatchObject({ clerk_org_id: "clerk_org_1", role: "member" })
  })

  test("never falls back to a personal organization for an unknown or unauthorized Clerk organization", async () => {
    const t = convexTest(schema, modules)

    await t.run(async (ctx) => {
      await ctx.db.insert("orgs", stamped({ clerk_org_id: "clerk_org_1", kind: "clerk", name: "Acme" }) as never)
      const userId = await ctx.db.insert("users", stamped({ token_identifier: "clerk|user_1", clerk_subject: "user_1" }) as never)
      const personalId = await ctx.db.insert("orgs", stamped({ kind: "personal", owner_user_id: userId, name: "Personal" }) as never)
      await ctx.db.insert("org_memberships", stamped({ org_id: personalId, user_id: userId, role: "owner" }) as never)
    })

    const asUser = t.withIdentity({ tokenIdentifier: "clerk|user_1", subject: "user_1" })

    // Unknown org: not silently downgraded to the personal org.
    await expect(asUser.mutation(api.orgs.resolveForMe, { clerk_org_id: "missing" } as never))
      .rejects.toThrow("Organization not found")

    // Known org the user is NOT a member of: membership is required, and the
    // personal org is still not substituted.
    await expect(asUser.mutation(api.orgs.resolveForMe, { clerk_org_id: "clerk_org_1" } as never))
      .rejects.toThrow("Organization membership is required")

    // No org requested at all: the personal org IS the correct answer.
    await expect(asUser.mutation(api.orgs.resolveForMe, {} as never))
      .resolves.toMatchObject({ role: "owner" })
  })
})
