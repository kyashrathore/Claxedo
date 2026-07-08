import { describe, expect, test } from "vitest"
import { applyClerkWebhook } from "../../../../convex/orgs"

type Row = Record<string, unknown> & { _id: string }

function db(seed: Record<string, Row[]>) {
  const rows = Object.fromEntries(Object.entries(seed).map(([key, value]) => [key, [...value]]))
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
    async patch(id: string, patch: Record<string, unknown>) {
      for (const table of Object.keys(rows)) {
        const index = rows[table]!.findIndex((row) => row._id === id)
        if (index === -1) continue
        rows[table]![index] = { ...rows[table]![index], ...patch }
        return
      }
      throw new Error(`Missing row ${id}`)
    },
    async delete(id: string) {
      for (const table of Object.keys(rows)) {
        const index = rows[table]!.findIndex((row) => row._id === id)
        if (index === -1) continue
        rows[table]!.splice(index, 1)
        return
      }
      throw new Error(`Missing row ${id}`)
    },
  }
}

function handler(fn: unknown) {
  return (fn as { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown> })._handler
}

describe("Convex org webhook policy", () => {
  test("organizationMembership.deleted removes the matching org membership", async () => {
    const store = db({
      orgs: [{ _id: "org_1", clerk_org_id: "clerk_org_1", kind: "clerk" }],
      users: [{ _id: "user_1", clerk_subject: "clerk_user_1", token_identifier: "token_1" }],
      org_memberships: [{ _id: "membership_1", org_id: "org_1", user_id: "user_1", role: "member" }],
    })

    await handler(applyClerkWebhook)({ db: store }, {
      type: "organizationMembership.deleted",
      data: {
        organization: { id: "clerk_org_1" },
        public_user_data: { user_id: "clerk_user_1" },
      },
    })

    expect(store.rows.org_memberships).toEqual([])
  })
})
