import { afterEach, describe, expect, test, vi } from "vitest"
import { revoke } from "../../../../../convex/workspaceShares"

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
          return (await query.collect())[0]
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
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("Convex workspace share revoke policy", () => {
  test("revoking a user share revokes only that user's active Runtime Access Tokens", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const store = db({
      users: [
        { _id: "user_owner", token_identifier: "owner_token" },
        { _id: "user_target", token_identifier: "target_token" },
        { _id: "user_other", token_identifier: "other_token" },
      ],
      workspaces: [
        { _id: "workspace_1", workspace_id: "ws_1", owner_user_id: "user_owner" },
      ],
      workspace_share_grants: [
        {
          _id: "grant_1",
          workspace_id: "workspace_1",
          granted_to_user_id: "user_target",
          role: "editor",
          created_by_user_id: "user_owner",
          created_at: 1,
        },
      ],
      runtime_access_tokens: [
        {
          _id: "token_target_active",
          jti: "jti_target_active",
          workspace_id: "workspace_1",
          host_id: "host_1",
          minted_for_user_id: "user_target",
          expires_at: 999_999,
          created_at: 1,
        },
        {
          _id: "token_target_already_revoked",
          jti: "jti_target_revoked",
          workspace_id: "workspace_1",
          host_id: "host_1",
          minted_for_user_id: "user_target",
          expires_at: 999_999,
          revoked_at: 42,
          created_at: 1,
        },
        {
          _id: "token_other_active",
          jti: "jti_other_active",
          workspace_id: "workspace_1",
          host_id: "host_1",
          minted_for_user_id: "user_other",
          expires_at: 999_999,
          created_at: 1,
        },
      ],
    })

    await expect((revoke as unknown as { _handler: (ctx: unknown, args: unknown) => Promise<unknown> })._handler({
      db: store,
      auth: {
        getUserIdentity: async () => ({
          tokenIdentifier: "owner_token",
        }),
      },
    }, {
      workspace_id: "ws_1",
      granted_to_token_identifier: "target_token",
    })).resolves.toEqual({
      revoked: true,
      runtime_tokens_revoked: 1,
    })

    expect(store.rows.workspace_share_grants[0]).toMatchObject({ revoked_at: 123_456 })
    expect(store.rows.runtime_access_tokens.find((row) => row._id === "token_target_active")).toMatchObject({
      revoked_at: 123_456,
    })
    expect(store.rows.runtime_access_tokens.find((row) => row._id === "token_target_already_revoked")).toMatchObject({
      revoked_at: 42,
    })
    expect(store.rows.runtime_access_tokens.find((row) => row._id === "token_other_active")).not.toHaveProperty("revoked_at")
  })
})
