import { afterEach, describe, expect, test, vi } from "vitest"
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
 * Every table here requires `created_at`/`updated_at`. The hand-rolled `db`
 * double this suite used to run against enforced nothing, so its seeds were
 * missing them and the schema drift went unnoticed.
 */
const stamped = <T extends Record<string, unknown>>(row: T) => ({ created_at: 1, updated_at: 1, ...row })

afterEach(() => {
  vi.restoreAllMocks()
})

async function seedWorkspace(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", stamped({ name: "Acme" }) as never)
    const ownerId = await ctx.db.insert("users", stamped({
      token_identifier: "user_token",
      public_id: "usr_owner",
      kind: "human",
    }) as never)
    const workspaceId = await ctx.db.insert(
      "workspaces",
      stamped({
        workspace_id: "ws_1",
        org_id: orgId,
        owner_user_id: ownerId,
        backing: "cloud-vm",
        access: "cloud",
        display_name: "Workspace 1",
      }) as never,
    )
    return { orgId, ownerId, workspaceId }
  })
}

function asOwner(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({ tokenIdentifier: "user_token", subject: "owner_subject" })
}

/**
 * Session visibility and transcript-sync policy (`convex/sessions.ts`).
 *
 * Runs against the real function pipeline via `convex-test` — including the
 * `authedQuery`/`authedMutation` wrappers from `model.ts`, which resolve
 * identity and decide `authorizeWorkspace(ctx, workspace, ...)` before a
 * handler ever runs. The previous version of this suite lived in
 * claxedo-server, imported `sessions.ts` across five directory levels,
 * reached past the builders into `_handler`, and drove a hand-written `db`
 * double — so it exercised the handler bodies while skipping the auth
 * wrappers that make them safe.
 */
describe("Convex session visibility policy", () => {
  test("an organization owner retains workspace admin authority without a membership mirror", async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const orgOwnerId = await ctx.db.insert("users", stamped({
        token_identifier: "org_owner_token",
        clerk_subject: "org_owner",
        kind: "human",
      }) as never)
      const workspaceOwnerId = await ctx.db.insert("users", stamped({
        token_identifier: "workspace_owner_token",
        kind: "human",
      }) as never)
      const orgId = await ctx.db.insert("orgs", stamped({ name: "Acme", owner_user_id: orgOwnerId }) as never)
      await ctx.db.insert("workspaces", stamped({
        workspace_id: "ws_org_owner",
        org_id: orgId,
        owner_user_id: workspaceOwnerId,
        backing: "cloud-vm",
        access: "cloud",
        display_name: "Org owner workspace",
      }) as never)
    })

    const orgOwner = t.withIdentity({ tokenIdentifier: "org_owner_token", subject: "org_owner" })
    await expect(orgOwner.mutation(api.sessions.upsertVisibility, {
      workspace_id: "ws_org_owner",
      sessions: [{ session_id: "ses_org_owner" }],
    } as never)).resolves.toEqual({ ok: true })
  })

  test("service projection reuses the webhook-mirrored user identity", async () => {
    const previousServiceToken = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
    process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "svc_secret"
    try {
      const t = convexTest(schema, modules)
      await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", stamped({
          token_identifier: "clerk:bob",
          clerk_subject: "bob",
          kind: "human",
        }) as never)
        const orgId = await ctx.db.insert("orgs", stamped({ name: "Acme", owner_user_id: userId }) as never)
        await ctx.db.insert("workspaces", stamped({
          workspace_id: "ws_service_identity",
          org_id: orgId,
          owner_user_id: userId,
          backing: "cloud-vm",
          access: "cloud",
          display_name: "Service identity",
        }) as never)
      })

      await expect(t.mutation(api.sessions.upsertVisibilityForService, {
        service_token: "svc_secret",
        user: {
          token_identifier: "https://identity.example.test|bob",
          subject: "bob",
          issuer: "https://identity.example.test",
        },
        workspace_id: "ws_service_identity",
        sessions: [{ session_id: "ses_service_identity" }],
      } as never)).resolves.toEqual({ ok: true })

      await t.run(async (ctx) => {
        const users = await ctx.db.query("users").collect()
        expect(users).toHaveLength(1)
        expect(users[0]).toMatchObject({
          token_identifier: "https://identity.example.test|bob",
          clerk_subject: "bob",
          kind: "human",
        })
      })
    } finally {
      if (previousServiceToken === undefined) delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
      else process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = previousServiceToken
    }
  })

  test("revoked creators cannot manage participants", async () => {
    const t = convexTest(schema, modules)
    const { workspaceId } = await seedWorkspace(t)
    const creatorId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", stamped({
        token_identifier: "creator_token",
        clerk_subject: "creator_subject",
        kind: "human",
      }) as never)
      await ctx.db.insert("workspace_memberships", stamped({
        workspace_id: workspaceId,
        user_id: userId,
        role: "editor",
      }) as never)
      const participantId = await ctx.db.insert("users", stamped({
        token_identifier: "participant_token",
        clerk_subject: "participant_subject",
        kind: "human",
      }) as never)
      await ctx.db.insert("workspace_memberships", stamped({
        workspace_id: workspaceId,
        user_id: participantId,
        role: "viewer",
      }) as never)
      return userId
    })
    const creator = t.withIdentity({ tokenIdentifier: "creator_token", subject: "creator_subject" })
    await creator.mutation(api.sessions.upsertVisibility, {
      workspace_id: "ws_1",
      sessions: [{ session_id: "ses_revoked_creator" }],
    } as never)
    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("workspace_memberships")
        .withIndex("by_workspace_user", (q: any) => q.eq("workspace_id", workspaceId).eq("user_id", creatorId))
        .unique()
      await ctx.db.delete(membership!._id)
    })

    await expect(creator.mutation(api.sessions.addParticipant, {
      workspace_id: "ws_1",
      session_id: "ses_revoked_creator",
      participant_token_identifier: "participant_token",
    } as never)).rejects.toThrow("session_participant_admin_required")
  })

  test("stores only basename-style directory hints", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const t = convexTest(schema, modules)
    await seedWorkspace(t)
    const asUser = asOwner(t)

    await expect(
      asUser.mutation(api.sessions.upsertVisibility, {
        workspace_id: "ws_1",
        sessions: [{ session_id: "ses_1", title: "Review", directory_hint: "  opencode  " }],
      } as never),
    ).resolves.toEqual({ ok: true })

    await t.run(async (ctx) => {
      const row = (await ctx.db.query("session_history").collect())[0]
      expect(row).toMatchObject({
        session_id: "ses_1",
        directory_hint: "opencode",
        created_at: 123_456,
        updated_at: 123_456,
      })
    })
  })

  test("stores and lists canonical public project ids", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const t = convexTest(schema, modules)
    const { ownerId, orgId } = await seedWorkspace(t)
    await t.run(async (ctx) =>
      ctx.db.insert(
        "projects",
        {
          project_id: "project_1",
          org_id: orgId,
          repo_key: "workspace:project_1",
          owner_user_id: ownerId,
          created_at: 1,
          updated_at: 1,
        } as never,
      ),
    )
    const asUser = asOwner(t)

    await expect(
      asUser.mutation(api.sessions.upsertVisibility, {
        workspace_id: "ws_1",
        sessions: [{ session_id: "ses_1", project_id: "project_1", title: "Review" }],
      } as never),
    ).resolves.toEqual({ ok: true })

    await t.run(async (ctx) => {
      const row = (await ctx.db.query("session_history").collect())[0]
      expect(row).toMatchObject({ session_id: "ses_1", project_id: "project_1" })
    })

    await expect(asUser.query(api.sessions.list, { workspace_id: "ws_1" } as never)).resolves.toMatchObject([
      { session_id: "ses_1", project_id: "project_1" },
    ])
  })

  test("rejects a session project that differs from the workspace project", async () => {
    const t = convexTest(schema, modules)
    const { ownerId, orgId, workspaceId } = await seedWorkspace(t)
    await t.run(async (ctx) => {
      for (const projectId of ["project_workspace", "project_other"]) {
        await ctx.db.insert("projects", stamped({
          project_id: projectId,
          org_id: orgId,
          repo_key: `workspace:${projectId}`,
          owner_user_id: ownerId,
        }) as never)
      }
      await ctx.db.patch(workspaceId, { project_id: "project_workspace" })
    })

    await expect(asOwner(t).mutation(api.sessions.upsertVisibility, {
      workspace_id: "ws_1",
      sessions: [{ session_id: "ses_wrong_project", project_id: "project_other" }],
    } as never)).rejects.toThrow("Session project must match workspace project")

    await t.run(async (ctx) => {
      expect(await ctx.db.query("session_history").collect()).toEqual([])
    })
  })

  test("rejects a workspace whose canonical project no longer exists", async () => {
    const t = convexTest(schema, modules)
    const { workspaceId } = await seedWorkspace(t)
    await t.run(async (ctx) => {
      await ctx.db.patch(workspaceId, { project_id: "project_missing" })
    })

    await expect(asOwner(t).mutation(api.sessions.upsertVisibility, {
      workspace_id: "ws_1",
      sessions: [{ session_id: "ses_missing_project" }],
    } as never)).rejects.toThrow("Workspace project not found")

    await t.run(async (ctx) => {
      expect(await ctx.db.query("session_history").collect()).toEqual([])
    })
  })

  test.each(["/Users/yash/opencode", "src/app", "src\\app", "C:\\repo", "~/.claxedo", ".", ".."])(
    "rejects path-like directory hint %s",
    async (directoryHint) => {
      const t = convexTest(schema, modules)
      await seedWorkspace(t)
      const asUser = asOwner(t)

      await expect(
        asUser.mutation(api.sessions.upsertVisibility, {
          workspace_id: "ws_1",
          sessions: [{ session_id: "ses_1", directory_hint: directoryHint }],
        } as never),
      ).rejects.toThrow("Invalid directory hint")
    },
  )

  test("syncs and reads session messages for authorized workspace readers", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const t = convexTest(schema, modules)
    await seedWorkspace(t)
    const asUser = asOwner(t)
    const ownerPublicId = await t.run(async (ctx) =>
      (await ctx.db.query("users").withIndex("by_token_identifier", (q) => q.eq("token_identifier", "user_token")).unique())!.public_id,
    )

    await expect(
      asUser.mutation(api.sessions.syncMessages, {
        workspace_id: "ws_1",
        session_id: "ses_1",
        messages: [
          {
            info: {
              id: "msg_1",
              role: "user",
              claxedo: { author: { id: ownerPublicId } },
            },
            parts: [{ type: "text", text: "hi" }],
          },
          { info: { id: "msg_2", role: "assistant" }, parts: [{ type: "text", text: "hello" }] },
        ],
      } as never),
    ).resolves.toEqual({ ok: true })

    await expect(
      asUser.query(api.sessions.readMessages, {
        workspace_id: "ws_1",
        session_id: "ses_1",
      } as never),
    ).resolves.toEqual({
      allowed: true,
      role: "owner",
      messages: [
        {
          info: {
            id: "msg_1",
            role: "user",
            claxedo: {
              author: {
                id: expect.stringMatching(/^usr_/),
                name: "User",
                kind: "human",
              },
            },
          },
          parts: [{ type: "text", text: "hi" }],
        },
        { info: { id: "msg_2", role: "assistant" }, parts: [{ type: "text", text: "hello" }] },
      ],
    })

    await t.run(async (ctx) => {
      const row = (await ctx.db.query("session_history").collect())[0]
      expect(row).toMatchObject({ session_id: "ses_1", created_at: 123_456, updated_at: 123_456 })
      const messages = await ctx.db.query("session_messages").collect()
      expect(messages.map((row) => row.message_id)).toEqual(["msg_1", "msg_2"])
    })
  })

  test("leaves forged and producer-unattributed user messages without an author", async () => {
    const t = convexTest(schema, modules)
    const { workspaceId } = await seedWorkspace(t)
    const { ownerPublicId } = await t.run(async (ctx) => {
      const owner = await ctx.db
        .query("users")
        .withIndex("by_token_identifier", (q) => q.eq("token_identifier", "user_token"))
        .unique()
      const collaboratorId = await ctx.db.insert("users", stamped({
        token_identifier: "collaborator_token",
        clerk_subject: "collaborator_subject",
        public_id: "usr_collaborator",
        kind: "human",
      }) as never)
      await ctx.db.insert("workspace_memberships", stamped({
        workspace_id: workspaceId,
        user_id: collaboratorId,
        role: "editor",
      }) as never)
      return { ownerPublicId: owner!.public_id }
    })
    const collaborator = t.withIdentity({
      tokenIdentifier: "collaborator_token",
      subject: "collaborator_subject",
    })

    await collaborator.mutation(api.sessions.syncMessages, {
      workspace_id: "ws_1",
      session_id: "ses_author_spoof",
      messages: [
        {
          info: {
            id: "msg_forged",
            role: "user",
            claxedo: { author: { id: ownerPublicId } },
          },
          parts: [],
        },
        { info: { id: "msg_unknown", role: "user" }, parts: [] },
      ],
    } as never)

    await t.run(async (ctx) => {
      const rows = await ctx.db.query("session_messages").collect()
      expect(rows.map((row) => ({ id: row.message_id, author: row.author_actor_id }))).toEqual([
        { id: "msg_forged", author: undefined },
        { id: "msg_unknown", author: undefined },
      ])
    })
    await expect(collaborator.query(api.sessions.readMessages, {
      workspace_id: "ws_1",
      session_id: "ses_author_spoof",
    } as never)).resolves.toMatchObject({
      allowed: true,
      messages: [
        { info: { id: "msg_forged", role: "user" } },
        { info: { id: "msg_unknown", role: "user" } },
      ],
    })
    const read = await collaborator.query(api.sessions.readMessages, {
      workspace_id: "ws_1",
      session_id: "ses_author_spoof",
    } as never) as { messages: unknown[] }
    expect(JSON.stringify(read.messages)).not.toContain("claxedo")
  })

  test("rejects an older message snapshot after a newer event ordinal commits", async () => {
    const t = convexTest(schema, modules)
    await seedWorkspace(t)
    const asUser = asOwner(t)
    const newer = [
      { info: { id: "msg_new_user", role: "user" }, parts: [{ type: "text", text: "New request" }] },
      { info: { id: "msg_new", role: "assistant" }, parts: [{ type: "text", text: "New response" }] },
    ]
    const older = [
      { info: { id: "msg_old_user", role: "user" }, parts: [{ type: "text", text: "Stale request" }] },
      { info: { id: "msg_old", role: "assistant" }, parts: [{ type: "text", text: "Stale response" }] },
    ]

    await expect(asUser.mutation(api.sessions.syncMessages, {
      workspace_id: "ws_1",
      session_id: "ses_ordinal",
      messages: newer,
      max_event_ordinal: 12,
    } as never)).resolves.toMatchObject({ ok: true, applied: true, maxEventOrdinal: 12 })
    await expect(asUser.mutation(api.sessions.syncMessages, {
      workspace_id: "ws_1",
      session_id: "ses_ordinal",
      messages: older,
      intake_ready: true,
      max_event_ordinal: 11,
    } as never)).resolves.toMatchObject({ ok: true, applied: false, maxEventOrdinal: 12 })
    await expect(asUser.query(api.sessions.readMessages, {
      workspace_id: "ws_1",
      session_id: "ses_ordinal",
    } as never)).resolves.toMatchObject({ messages: newer })
    await expect(t.run(async (ctx) => ctx.db.query("workgraph_due_jobs").collect())).resolves.toEqual([])
  })

  test("waits for an explicit idle observation before enqueuing independent Session intake", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const t = convexTest(schema, modules)
    await seedWorkspace(t)
    const asUser = asOwner(t)
    const args = {
      workspace_id: "ws_1",
      session_id: "ses_idle",
      messages: [
        { info: { id: "msg_1", role: "user" }, parts: [{ type: "text", text: "Plan launch" }] },
        { info: { id: "msg_2", role: "assistant" }, parts: [{ type: "text", text: "First partial summary" }] },
      ],
    }

    await expect(asUser.mutation(api.sessions.syncMessages, {
      ...args,
      intake_ready: false,
      max_event_ordinal: 12,
    } as never)).resolves.toMatchObject({ ok: true, applied: true, maxEventOrdinal: 12 })
    await expect(t.run(async (ctx) => ctx.db.query("workgraph_due_jobs").collect())).resolves.toEqual([])

    await expect(asUser.mutation(api.sessions.syncMessages, {
      ...args,
      intake_ready: true,
      max_event_ordinal: 12,
    } as never)).resolves.toMatchObject({ ok: true, applied: false, maxEventOrdinal: 12 })
    await expect(t.run(async (ctx) => ctx.db.query("workgraph_due_jobs").collect())).resolves.toEqual([
      expect.objectContaining({
        job_type: "session_intake",
        subject_id: "ses_idle",
        payload: expect.objectContaining({ sessionId: "ses_idle", summary: "First partial summary" }),
      }),
    ])
  })

  test("persists Session messages while owner deletion suppresses WorkGraph intake", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const t = convexTest(schema, modules)
    const { orgId, ownerId } = await seedWorkspace(t)
    await t.run(async (ctx) => {
      await ctx.db.insert("workgraph_owner_deletion_barriers", {
        organization_id: orgId,
        owner_user_id: ownerId,
        operation_hash: "hash_1",
        lease_expires_at: 999_999,
        created_at: 1,
        updated_at: 1,
      } as never)
    })
    const asUser = asOwner(t)
    const messages = [
      { info: { id: "msg_1", role: "user" }, parts: [{ type: "text", text: "Plan launch" }] },
      { info: { id: "msg_2", role: "assistant" }, parts: [{ type: "text", text: "Summary" }] },
    ]

    await expect(
      asUser.mutation(api.sessions.syncMessages, {
        workspace_id: "ws_1",
        session_id: "ses_deleting",
        messages,
        intake_ready: true,
      } as never),
    ).resolves.toEqual({ ok: true })

    await t.run(async (ctx) => {
      const sessionMessages = await ctx.db.query("session_messages").collect()
      expect(sessionMessages).toHaveLength(2)
      const jobs = await ctx.db.query("workgraph_due_jobs").collect()
      expect(jobs).toEqual([])
    })
  })

  test("message sync preserves existing session metadata", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const t = convexTest(schema, modules)
    await seedWorkspace(t)
    const asUser = asOwner(t)

    await asUser.mutation(api.sessions.upsertVisibility, {
      workspace_id: "ws_1",
      sessions: [{ session_id: "ses_1", title: "Review", directory_hint: "opencode" }],
    } as never)

    vi.spyOn(Date, "now").mockReturnValue(234_567)
    await expect(
      asUser.mutation(api.sessions.syncMessages, {
        workspace_id: "ws_1",
        session_id: "ses_1",
        messages: [{ info: { id: "msg_1", role: "user" }, parts: [] }],
      } as never),
    ).resolves.toEqual({ ok: true })

    await t.run(async (ctx) => {
      const row = (await ctx.db.query("session_history").collect())[0]
      expect(row).toMatchObject({
        session_id: "ses_1",
        title: "Review",
        directory_hint: "opencode",
        created_at: 123_456,
        updated_at: 123_456,
      })
    })
  })

  test("message sync updates changed rows and prunes stale rows", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const t = convexTest(schema, modules)
    await seedWorkspace(t)
    const asUser = asOwner(t)

    await asUser.mutation(api.sessions.syncMessages, {
      workspace_id: "ws_1",
      session_id: "ses_1",
      messages: [
        { info: { id: "msg_1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
        { info: { id: "msg_2", role: "assistant" }, parts: [{ type: "text", text: "hello" }] },
      ],
    } as never)
    const firstMsg2 = await t.run(async (ctx) =>
      (await ctx.db.query("session_messages").collect()).find((row) => row.message_id === "msg_2"),
    )

    vi.spyOn(Date, "now").mockReturnValue(234_567)
    await asUser.mutation(api.sessions.syncMessages, {
      workspace_id: "ws_1",
      session_id: "ses_1",
      messages: [
        { info: { id: "msg_2", role: "assistant" }, parts: [{ type: "text", text: "changed" }] },
        { info: { id: "msg_3", role: "user" }, parts: [{ type: "text", text: "next" }] },
      ],
    } as never)

    await t.run(async (ctx) => {
      const messages = await ctx.db.query("session_messages").collect()
      expect(messages.map((row) => row.message_id)).toEqual(["msg_2", "msg_3"])
      expect(messages.find((row) => row.message_id === "msg_1")).toBeUndefined()
      expect(messages.find((row) => row.message_id === "msg_2")).toMatchObject({
        _id: firstMsg2?._id,
        ordinal: 0,
        updated_at: 234_567,
        data: { info: { id: "msg_2", role: "assistant" }, parts: [{ type: "text", text: "changed" }] },
      })
    })
  })
})
