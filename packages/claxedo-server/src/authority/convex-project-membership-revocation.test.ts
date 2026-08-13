import { describe, expect, test, vi } from "vitest"
import { convexTest } from "convex-test"
import { revokeProjectUserRuntimeTokens } from "../../../../convex/projectMemberships"
import schema from "../../../../convex/schema"
import { api } from "../../../../convex/_generated/api"

const modules = import.meta.glob("../../../../convex/**/*.{ts,js}")

type Row = Record<string, unknown> & { _id: string }

function db(seed: Record<string, Row[]>) {
  const rows = Object.fromEntries(Object.entries(seed).map(([table, values]) => [table, [...values]]))
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
      }
      return query
    },
    async patch(id: string, patch: Record<string, unknown>) {
      for (const values of Object.values(rows)) {
        const row = values.find((item) => item._id === id)
        if (!row) continue
        Object.assign(row, patch)
        return
      }
      throw new Error(`Missing row ${id}`)
    },
  }
}

describe("Convex project membership revocation", () => {
  test("revokes the member's active tokens in every workspace for the project", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const store = db({
      workspaces: [
        { _id: "workspace_a", org_id: "org_1", project_id: "project_1" },
        { _id: "workspace_b", org_id: "org_1", project_id: "project_1" },
        { _id: "workspace_other", org_id: "org_1", project_id: "project_2" },
      ],
      runtime_access_tokens: [
        { _id: "token_a", workspace_id: "workspace_a", minted_for_user_id: "user_1" },
        { _id: "token_b", workspace_id: "workspace_b", minted_for_user_id: "user_1" },
        { _id: "token_other_project", workspace_id: "workspace_other", minted_for_user_id: "user_1" },
        { _id: "token_other_user", workspace_id: "workspace_a", minted_for_user_id: "user_2" },
      ],
    })

    await expect(revokeProjectUserRuntimeTokens({ db: store }, {
      org_id: "org_1",
      project_id: "project_1",
    }, "user_1")).resolves.toBe(2)

    expect(store.rows.runtime_access_tokens.find((row) => row._id === "token_a")).toMatchObject({ revoked_at: 123_456 })
    expect(store.rows.runtime_access_tokens.find((row) => row._id === "token_b")).toMatchObject({ revoked_at: 123_456 })
    expect(store.rows.runtime_access_tokens.find((row) => row._id === "token_other_project")).not.toHaveProperty("revoked_at")
    expect(store.rows.runtime_access_tokens.find((row) => row._id === "token_other_user")).not.toHaveProperty("revoked_at")
    vi.restoreAllMocks()
  })

  test("the add upsert revokes active tokens when it lowers an existing role", async () => {
    const backend = convexTest(schema, modules)
    const alice = backend.withIdentity({
      issuer: "https://identity.example.test",
      subject: "alice",
      tokenIdentifier: "https://identity.example.test|alice",
    })
    const bob = backend.withIdentity({
      issuer: "https://identity.example.test",
      subject: "bob",
      tokenIdentifier: "https://identity.example.test|bob",
    })
    await Promise.all([alice.mutation(api.users.me), bob.mutation(api.users.me)])
    await alice.mutation(api.workspaces.createCloud, {
      workspace_id: "ws_project_downgrade",
      display_name: "Project downgrade",
      repo_url: "https://github.com/claxedo/opencode.git",
    })
    const projectId = await backend.run(async (ctx) =>
      (await ctx.db.query("workspaces").withIndex("by_workspace_id", (q) =>
        q.eq("workspace_id", "ws_project_downgrade")
      ).unique())!.project_id
    )
    await alice.mutation(api.projectMemberships.add, {
      project_id: projectId,
      token_identifier: "https://identity.example.test|bob",
      role: "admin",
    })
    await bob.mutation(api.runtimeAccessTokens.recordMint, {
      jti: "jti_project_downgrade",
      workspace_id: "ws_project_downgrade",
      host_id: "host_project_downgrade",
      expires_at: Date.now() + 60_000,
    })

    await expect(alice.mutation(api.projectMemberships.add, {
      project_id: projectId,
      token_identifier: "https://identity.example.test|bob",
      role: "viewer",
    })).resolves.toMatchObject({ runtime_tokens_revoked: 1 })
    await expect(backend.run(async (ctx) =>
      await ctx.db.query("runtime_access_tokens").withIndex("by_jti", (q) =>
        q.eq("jti", "jti_project_downgrade")
      ).unique()
    )).resolves.toMatchObject({ revoked_at: expect.any(Number) })
  })

  test("membership downgrade also revokes SERVICE-minted (hosted) tokens", async () => {
    // Regression: recordMintForService stored only workspace_public_id/
    // minted_for_subject, so the by_workspace_user revocation index never matched
    // it and a kicked hosted user's RAT survived to expiry. The mint now also
    // resolves the workspace + user doc ids so revocation reaches it.
    const prevServiceToken = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
    process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "svc_secret"
    try {
      const backend = convexTest(schema, modules)
      const alice = backend.withIdentity({
        issuer: "https://identity.example.test",
        subject: "alice",
        tokenIdentifier: "https://identity.example.test|alice",
      })
      const bob = backend.withIdentity({
        issuer: "https://identity.example.test",
        subject: "bob",
        tokenIdentifier: "https://identity.example.test|bob",
      })
      await Promise.all([alice.mutation(api.users.me), bob.mutation(api.users.me)])
      await alice.mutation(api.workspaces.createCloud, {
        workspace_id: "ws_service_revoke",
        display_name: "Service revoke",
        repo_url: "https://github.com/claxedo/opencode.git",
      })
      const projectId = await backend.run(async (ctx) =>
        (await ctx.db.query("workspaces").withIndex("by_workspace_id", (q) =>
          q.eq("workspace_id", "ws_service_revoke")
        ).unique())!.project_id
      )
      await alice.mutation(api.projectMemberships.add, {
        project_id: projectId,
        token_identifier: "https://identity.example.test|bob",
        role: "admin",
      })

      // Mint a HOSTED (service) RAT for bob — the shape that previously escaped
      // revocation. subject is bob's raw JWT subject (== his clerk_subject).
      await backend.mutation(api.runtimeAccessTokens.recordMintForService, {
        service_token: "svc_secret",
        jti: "jti_service_revoke",
        workspace_id: "ws_service_revoke",
        host_id: "host_service_revoke",
        subject: "bob",
        expires_at: Date.now() + 60_000,
      })

      // The mint resolved the doc-id keys so the revocation index can reach it.
      const minted = await backend.run(async (ctx) =>
        await ctx.db.query("runtime_access_tokens").withIndex("by_jti", (q) =>
          q.eq("jti", "jti_service_revoke")
        ).unique()
      )
      expect(minted?.minted_for_user_id).toBeDefined()
      expect(minted?.workspace_id).toBeDefined()

      // Downgrading bob revokes his tokens — including the service-minted one.
      await alice.mutation(api.projectMemberships.add, {
        project_id: projectId,
        token_identifier: "https://identity.example.test|bob",
        role: "viewer",
      })
      await expect(backend.run(async (ctx) =>
        await ctx.db.query("runtime_access_tokens").withIndex("by_jti", (q) =>
          q.eq("jti", "jti_service_revoke")
        ).unique()
      )).resolves.toMatchObject({ revoked_at: expect.any(Number) })
    } finally {
      if (prevServiceToken === undefined) delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
      else process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = prevServiceToken
    }
  })
})
