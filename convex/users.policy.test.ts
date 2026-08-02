import { describe, expect, test } from "vitest"
import { convexTest } from "convex-test"
import { api } from "./_generated/api"
import schema from "./schema"

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob("./**/*.ts")

/**
 * `users.me` policy: an authenticated caller with no prior row gets a
 * concrete personal org, not a promise of one. Runs through the real
 * `authedMutation` wrapper (`model.ts`) via `convex-test` — the previous
 * version of this suite drove a hand-written `db` double and reached past the
 * builder into `_handler`, so it never exercised identity resolution at all.
 */
describe("Convex users policy", () => {
  test("users.me returns a concrete personal org for new users", async () => {
    const t = convexTest(schema, modules)
    const asUser = t.withIdentity({
      tokenIdentifier: "token_1",
      subject: "user_1",
      email: "user@example.test",
      name: "User One",
    })

    const result = await asUser.mutation(api.users.me, {})

    expect(result).toMatchObject({
      subject: "user_1",
      token_identifier: "token_1",
    })
    expect(result.org_id).toBeTruthy()

    const org = await t.run(async (ctx) => ctx.db.get(result.org_id as never))
    expect(org).toMatchObject({ kind: "personal", owner_user_id: result.user_id })

    const memberships = await t.run(async (ctx) => ctx.db.query("org_memberships").collect())
    expect(memberships).toMatchObject([{ org_id: result.org_id, user_id: result.user_id, role: "owner" }])
  })
})
