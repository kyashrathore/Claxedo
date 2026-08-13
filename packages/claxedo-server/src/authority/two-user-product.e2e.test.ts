import { describe, expect, test } from "vitest"
import { convexTest } from "convex-test"
import schema from "../../../../convex/schema"
import { api } from "../../../../convex/_generated/api"

const modules = import.meta.glob("../../../../convex/**/*.{ts,js}")

const aliceIdentity = {
  issuer: "https://identity.example.test",
  subject: "alice",
  tokenIdentifier: "https://identity.example.test|alice",
  name: "Alice",
  email: "alice@example.test",
  pictureUrl: "https://images.example.test/alice.png",
}

const bobIdentity = {
  issuer: "https://identity.example.test",
  subject: "bob",
  tokenIdentifier: "https://identity.example.test|bob",
  name: "Bob",
  email: "bob@example.test",
  pictureUrl: "https://images.example.test/bob.png",
}

const caseyIdentity = {
  issuer: "https://identity.example.test",
  subject: "casey",
  tokenIdentifier: "https://identity.example.test|casey",
  name: "Casey",
  email: "casey@example.test",
  pictureUrl: "https://images.example.test/casey.png",
}

const danaIdentity = {
  issuer: "https://identity.example.test",
  subject: "dana",
  tokenIdentifier: "https://identity.example.test|dana",
  name: "Dana",
  email: "dana@example.test",
  pictureUrl: "https://images.example.test/dana.png",
}

describe("two-user managed-product proof", () => {
  test("drives team, workspace, private-session, attribution, and revocation through real Convex functions", async () => {
    const testBackend = convexTest(schema, modules)
    const alice = testBackend.withIdentity(aliceIdentity)
    const bob = testBackend.withIdentity(bobIdentity)
    const casey = testBackend.withIdentity(caseyIdentity)
    const dana = testBackend.withIdentity(danaIdentity)

    const [aliceProfile, bobProfile, caseyProfile, danaProfile] = await Promise.all([
      alice.mutation(api.users.me),
      bob.mutation(api.users.me),
      casey.mutation(api.users.me),
      dana.mutation(api.users.me),
    ])
    expect(aliceProfile).toMatchObject({
      actor_kind: "human",
      actor_name: "Alice",
      actor_avatar_url: aliceIdentity.pictureUrl,
    })
    expect(bobProfile).toMatchObject({
      actor_kind: "human",
      actor_name: "Bob",
      actor_avatar_url: bobIdentity.pictureUrl,
    })
    expect(aliceProfile.actor_public_id).toMatch(/^usr_/)
    expect(bobProfile.actor_public_id).toMatch(/^usr_/)
    expect(aliceProfile.actor_public_id).not.toBe(bobProfile.actor_public_id)
    expect(aliceProfile.actor_id).not.toBe(aliceProfile.actor_public_id)

    const team = await alice.mutation(api.orgs.createTeam, { name: "Acme" })
    await testBackend.run(async (ctx) => {
      const now = Date.now()
      await Promise.all([
        ctx.db.insert("org_memberships", {
          org_id: team.org_id,
          user_id: danaProfile.user_id,
          role: "admin",
          created_at: now,
          updated_at: now,
        }),
        ctx.db.insert("org_memberships", {
          org_id: team.org_id,
          user_id: bobProfile.user_id,
          role: "member",
          created_at: now,
          updated_at: now,
        }),
        ctx.db.insert("org_memberships", {
          org_id: team.org_id,
          user_id: caseyProfile.user_id,
          role: "member",
          created_at: now,
          updated_at: now,
        }),
      ])
    })

    await expect(dana.mutation(api.workspaces.createCloud, {
      workspace_id: "ws_dana",
      org_id: team.org_id,
      display_name: "Admin workspace",
      repo_url: "https://github.com/acme/admin.git",
    })).resolves.toMatchObject({ workspace_doc_id: expect.any(String) })
    await expect(casey.mutation(api.workspaces.createCloud, {
      workspace_id: "ws_casey",
      org_id: team.org_id,
      display_name: "Member workspace",
      repo_url: "https://github.com/acme/member.git",
    })).rejects.toThrow("workspace_create_forbidden")

    await alice.mutation(api.workspaces.createCloud, {
      workspace_id: "ws_private",
      org_id: team.org_id,
      display_name: "Private workspace",
      repo_url: "https://github.com/acme/private.git",
    })
    await Promise.all([
      alice.mutation(api.workspaceShares.grant, {
        workspace_id: "ws_private",
        role: "editor",
        granted_to_token_identifier: bobIdentity.tokenIdentifier,
      }),
      alice.mutation(api.workspaceShares.grant, {
        workspace_id: "ws_private",
        role: "editor",
        granted_to_token_identifier: caseyIdentity.tokenIdentifier,
      }),
    ])
    await alice.mutation(api.sessions.upsertVisibility, {
      workspace_id: "ws_private",
      sessions: [{ session_id: "ses_private", title: "Private design" }],
    })
    await alice.mutation(api.sessions.syncMessages, {
      workspace_id: "ws_private",
      session_id: "ses_private",
      messages: [{ id: "msg_alice", role: "user", text: "Alice wrote this" }],
    })

    await expect(casey.query(api.sessions.readMessages, {
      workspace_id: "ws_private",
      session_id: "ses_private",
    })).resolves.toEqual({ allowed: false, messages: [] })
    await expect(casey.query(api.sessions.list, { workspace_id: "ws_private" })).resolves.toEqual([])
    await expect(casey.query(api.sessions.resolve, { session_id: "ses_private" })).resolves.toBeNull()

    await alice.mutation(api.sessions.addParticipant, {
      workspace_id: "ws_private",
      session_id: "ses_private",
      participant_token_identifier: bobIdentity.tokenIdentifier,
    })
    await expect(bob.query(api.sessions.readMessages, {
      workspace_id: "ws_private",
      session_id: "ses_private",
    })).resolves.toMatchObject({ allowed: true, messages: [{ id: "msg_alice" }] })
    await expect(bob.mutation(api.sessions.syncMessages, {
      workspace_id: "ws_private",
      session_id: "ses_private",
      messages: [
        { id: "msg_alice", role: "user", text: "Alice wrote this" },
        { id: "msg_bob", role: "user", text: "Bob replied" },
      ],
    })).resolves.toEqual({ ok: true })
    await expect(bob.mutation(api.sessions.replaceVisibility, {
      workspace_id: "ws_private",
      sessions: [],
    })).resolves.toEqual({ ok: true })
    await expect(alice.query(api.sessions.list, { workspace_id: "ws_private" }))
      .resolves.toEqual([expect.objectContaining({ session_id: "ses_private" })])

    await bob.mutation(api.runtimeAccessTokens.recordMint, {
      jti: "jti_bob",
      workspace_id: "ws_private",
      host_id: "host_private",
      expires_at: Date.now() + 60_000,
    })
    await alice.mutation(api.sessions.removeParticipant, {
      workspace_id: "ws_private",
      session_id: "ses_private",
      participant_token_identifier: bobIdentity.tokenIdentifier,
    })
    await alice.mutation(api.workspaceShares.revoke, {
      workspace_id: "ws_private",
      granted_to_token_identifier: bobIdentity.tokenIdentifier,
    })

    await expect(bob.query(api.sessions.readMessages, {
      workspace_id: "ws_private",
      session_id: "ses_private",
    })).resolves.toEqual({ allowed: false, messages: [] })
    const token = await testBackend.run(async (ctx) =>
      await ctx.db.query("runtime_access_tokens").withIndex("by_jti", (q) => q.eq("jti", "jti_bob")).unique()
    )
    expect(token?.revoked_at).toEqual(expect.any(Number))
  })
})
