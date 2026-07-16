import { describe, expect, test } from "vitest"
import { applyClerkWebhook, resolveForMe } from "../../../../convex/orgs"

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
    async get(id: string) {
      return Object.values(rows).flat().find((row) => row._id === id) ?? null
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

  test("resolves an explicit Clerk organization only through a durable membership", async () => {
    const store = db({
      orgs: [{ _id: "org_1", clerk_org_id: "clerk_org_1", kind: "clerk" }],
      users: [{ _id: "user_1", token_identifier: "clerk|user_1", clerk_subject: "user_1" }],
      org_memberships: [{ _id: "membership_1", org_id: "org_1", user_id: "user_1", role: "member" }],
    })

    await expect(handler(resolveForMe)({
      db: store,
      auth: { getUserIdentity: async () => ({ tokenIdentifier: "clerk|user_1", subject: "user_1" }) },
    }, { clerk_org_id: "clerk_org_1" })).resolves.toMatchObject({
      org_id: "org_1",
      clerk_org_id: "clerk_org_1",
      role: "member",
    })
  })

  test("never falls back to a personal organization for an unknown or unauthorized Clerk organization", async () => {
    const store = db({
      orgs: [
        { _id: "org_1", clerk_org_id: "clerk_org_1", kind: "clerk" },
        { _id: "personal_1", kind: "personal", owner_user_id: "user_1" },
      ],
      users: [{ _id: "user_1", token_identifier: "clerk|user_1", clerk_subject: "user_1" }],
      org_memberships: [{ _id: "personal_membership", org_id: "personal_1", user_id: "user_1", role: "owner" }],
    })
    const context = {
      db: store,
      auth: { getUserIdentity: async () => ({ tokenIdentifier: "clerk|user_1", subject: "user_1" }) },
    }

    await expect(handler(resolveForMe)(context, { clerk_org_id: "missing" })).rejects.toThrow("Organization not found")
    await expect(handler(resolveForMe)(context, { clerk_org_id: "clerk_org_1" })).rejects.toThrow(
      "Organization membership is required",
    )
    await expect(handler(resolveForMe)(context, {})).resolves.toMatchObject({ org_id: "personal_1", role: "owner" })
  })
})
