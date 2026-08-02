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
    const ownerId = await ctx.db.insert("users", stamped({ token_identifier: "user_token" }) as never)
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

  test("stores internal project ids and lists public project ids", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const t = convexTest(schema, modules)
    const { ownerId } = await seedWorkspace(t)
    const projectDocId = await t.run(async (ctx) =>
      ctx.db.insert(
        "projects",
        { project_id: "project_1", owner_user_id: ownerId, created_at: 1, updated_at: 1 } as never,
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
      expect(row).toMatchObject({ session_id: "ses_1", project_id: projectDocId })
    })

    await expect(asUser.query(api.sessions.list, { workspace_id: "ws_1" } as never)).resolves.toMatchObject([
      { session_id: "ses_1", project_id: "project_1" },
    ])
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

    await expect(
      asUser.mutation(api.sessions.syncMessages, {
        workspace_id: "ws_1",
        session_id: "ses_1",
        messages: [
          { info: { id: "msg_1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
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
        { info: { id: "msg_1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
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

    await asUser.mutation(api.sessions.syncMessages, { ...args, intake_ready: false } as never)
    await expect(t.run(async (ctx) => ctx.db.query("workgraph_due_jobs").collect())).resolves.toEqual([])

    await asUser.mutation(api.sessions.syncMessages, { ...args, intake_ready: true } as never)
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
