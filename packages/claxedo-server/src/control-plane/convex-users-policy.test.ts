import { describe, expect, test } from "vitest"
import { me } from "../../../../convex/users"

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
        async first() {
          return (await query.collect())[0] ?? null
        },
      }
      return query
    },
    async insert(table: string, row: Record<string, unknown>) {
      const id = `${table}:${(rows[table] ?? []).length + 1}`
      rows[table] ??= []
      rows[table].push({ _id: id, ...row })
      return id
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
  }
}

function handler(fn: unknown) {
  return (fn as { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown> })._handler
}

describe("Convex users policy", () => {
  test("users.me returns a concrete personal org for new users", async () => {
    const store = db({
      users: [],
      orgs: [],
      org_memberships: [],
    })

    const result = await handler(me)({
      db: store,
      auth: {
        getUserIdentity: async () => ({
          tokenIdentifier: "token_1",
          subject: "user_1",
          issuer: process.env.CLERK_JWT_ISSUER_DOMAIN ?? process.env.CLERK_JWT_ISSUER,
          email: "user@example.test",
          name: "User One",
        }),
      },
    }, {})

    expect(result).toMatchObject({
      user_id: "users:1",
      subject: "user_1",
      token_identifier: "token_1",
      org_id: "orgs:1",
    })
    expect(store.rows.orgs[0]).toMatchObject({
      _id: "orgs:1",
      kind: "personal",
      owner_user_id: "users:1",
    })
    expect(store.rows.org_memberships[0]).toMatchObject({
      org_id: "orgs:1",
      user_id: "users:1",
      role: "owner",
    })
  })
})
