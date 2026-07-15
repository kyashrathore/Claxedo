import { afterEach, describe, expect, test, vi } from "vitest"
import { list, readMessages, syncMessages, upsertVisibility } from "../../../../convex/sessions"

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
        filter() {
          return query
        },
        async first() {
          return (await query.collect())[0]
        },
        async take(limit: number) {
          return (await query.collect()).slice(0, limit)
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
    async get(id: string) {
      for (const table of Object.keys(rows)) {
        const row = rows[table]!.find((row) => row._id === id)
        if (row) return row
      }
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

function ctx() {
  return {
    db: db({
      users: [{ _id: "user_1", token_identifier: "user_token" }],
      projects: [{ _id: "project_1_doc", project_id: "project_1", owner_user_id: "user_1" }],
      workspaces: [
        { _id: "workspace_1", workspace_id: "ws_1", org_id: "org_1", owner_user_id: "user_1", project_id: "project_1" },
      ],
      workspace_memberships: [],
      workspace_share_grants: [],
      org_memberships: [],
      session_history: [],
      session_messages: [],
      workgraph_attempts: [],
      workgraph_due_jobs: [],
      workgraph_owner_deletion_barriers: [],
    }),
    auth: {
      getUserIdentity: async () => ({
        tokenIdentifier: "user_token",
      }),
    },
  }
}

function handler(fn: unknown) {
  return (fn as { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown> })._handler
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("Convex session visibility policy", () => {
  test("stores only basename-style directory hints", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const input = ctx()

    await expect(
      handler(upsertVisibility)(input, {
        workspace_id: "ws_1",
        sessions: [
          {
            session_id: "ses_1",
            title: "Review",
            directory_hint: "  opencode  ",
          },
        ],
      }),
    ).resolves.toEqual({ ok: true })

    expect(input.db.rows.session_history[0]).toMatchObject({
      session_id: "ses_1",
      directory_hint: "opencode",
      created_at: 123_456,
      updated_at: 123_456,
    })
  })

  test("stores internal project ids and lists public project ids", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const input = ctx()

    await expect(
      handler(upsertVisibility)(input, {
        workspace_id: "ws_1",
        sessions: [
          {
            session_id: "ses_1",
            project_id: "project_1",
            title: "Review",
          },
        ],
      }),
    ).resolves.toEqual({ ok: true })

    expect(input.db.rows.session_history[0]).toMatchObject({
      session_id: "ses_1",
      project_id: "project_1_doc",
    })
    await expect(
      handler(list)(input, {
        workspace_id: "ws_1",
      }),
    ).resolves.toMatchObject([
      {
        session_id: "ses_1",
        project_id: "project_1",
      },
    ])
  })

  test.each(["/Users/yash/opencode", "src/app", "src\\app", "C:\\repo", "~/.claxedo", ".", ".."])(
    "rejects path-like directory hint %s",
    async (directoryHint) => {
      await expect(
        handler(upsertVisibility)(ctx(), {
          workspace_id: "ws_1",
          sessions: [
            {
              session_id: "ses_1",
              directory_hint: directoryHint,
            },
          ],
        }),
      ).rejects.toThrow("Invalid directory hint")
    },
  )

  test("syncs and reads session messages for authorized workspace readers", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const input = ctx()

    await expect(
      handler(syncMessages)(input, {
        workspace_id: "ws_1",
        session_id: "ses_1",
        messages: [
          { info: { id: "msg_1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
          { info: { id: "msg_2", role: "assistant" }, parts: [{ type: "text", text: "hello" }] },
        ],
      }),
    ).resolves.toEqual({ ok: true })

    await expect(
      handler(readMessages)(input, {
        workspace_id: "ws_1",
        session_id: "ses_1",
      }),
    ).resolves.toEqual({
      allowed: true,
      role: "owner",
      messages: [
        { info: { id: "msg_1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
        { info: { id: "msg_2", role: "assistant" }, parts: [{ type: "text", text: "hello" }] },
      ],
    })
    expect(input.db.rows.session_history[0]).toMatchObject({
      session_id: "ses_1",
      created_at: 123_456,
      updated_at: 123_456,
    })
    expect(input.db.rows.session_messages.map((row) => row.message_id)).toEqual(["msg_1", "msg_2"])
  })

  test("waits for an explicit idle observation before enqueuing independent Session intake", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const input = ctx()
    const args = {
      workspace_id: "ws_1",
      session_id: "ses_idle",
      messages: [
        { info: { id: "msg_1", role: "user" }, parts: [{ type: "text", text: "Plan launch" }] },
        { info: { id: "msg_2", role: "assistant" }, parts: [{ type: "text", text: "First partial summary" }] },
      ],
    }

    await handler(syncMessages)(input, { ...args, intake_ready: false })
    expect(input.db.rows.workgraph_due_jobs).toEqual([])

    await handler(syncMessages)(input, { ...args, intake_ready: true })
    expect(input.db.rows.workgraph_due_jobs).toEqual([
      expect.objectContaining({
        job_type: "session_intake",
        subject_id: "ses_idle",
        payload: expect.objectContaining({ sessionId: "ses_idle", summary: "First partial summary" }),
      }),
    ])
  })

  test("persists Session messages while owner deletion suppresses WorkGraph intake", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const input = ctx()
    input.db.rows.workgraph_owner_deletion_barriers.push({
      _id: "barrier_1",
      organization_id: "org_1",
      owner_user_id: "user_1",
    })
    const messages = [
      { info: { id: "msg_1", role: "user" }, parts: [{ type: "text", text: "Plan launch" }] },
      { info: { id: "msg_2", role: "assistant" }, parts: [{ type: "text", text: "Summary" }] },
    ]

    await expect(
      handler(syncMessages)(input, {
        workspace_id: "ws_1",
        session_id: "ses_deleting",
        messages,
        intake_ready: true,
      }),
    ).resolves.toEqual({ ok: true })

    expect(input.db.rows.session_messages).toHaveLength(2)
    expect(input.db.rows.workgraph_due_jobs).toEqual([])
  })

  test("message sync preserves existing session metadata", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const input = ctx()

    await handler(upsertVisibility)(input, {
      workspace_id: "ws_1",
      sessions: [
        {
          session_id: "ses_1",
          title: "Review",
          directory_hint: "opencode",
        },
      ],
    })

    vi.spyOn(Date, "now").mockReturnValue(234_567)
    await expect(
      handler(syncMessages)(input, {
        workspace_id: "ws_1",
        session_id: "ses_1",
        messages: [{ info: { id: "msg_1", role: "user" }, parts: [] }],
      }),
    ).resolves.toEqual({ ok: true })

    expect(input.db.rows.session_history[0]).toMatchObject({
      session_id: "ses_1",
      title: "Review",
      directory_hint: "opencode",
      created_at: 123_456,
      updated_at: 123_456,
    })
  })

  test("message sync updates changed rows and prunes stale rows", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const input = ctx()

    await handler(syncMessages)(input, {
      workspace_id: "ws_1",
      session_id: "ses_1",
      messages: [
        { info: { id: "msg_1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
        { info: { id: "msg_2", role: "assistant" }, parts: [{ type: "text", text: "hello" }] },
      ],
    })
    const firstMsg2 = input.db.rows.session_messages.find((row) => row.message_id === "msg_2")

    vi.spyOn(Date, "now").mockReturnValue(234_567)
    await handler(syncMessages)(input, {
      workspace_id: "ws_1",
      session_id: "ses_1",
      messages: [
        { info: { id: "msg_2", role: "assistant" }, parts: [{ type: "text", text: "changed" }] },
        { info: { id: "msg_3", role: "user" }, parts: [{ type: "text", text: "next" }] },
      ],
    })

    expect(input.db.rows.session_messages.map((row) => row.message_id)).toEqual(["msg_2", "msg_3"])
    expect(input.db.rows.session_messages.find((row) => row.message_id === "msg_1")).toBeUndefined()
    expect(input.db.rows.session_messages.find((row) => row.message_id === "msg_2")).toMatchObject({
      _id: firstMsg2?._id,
      ordinal: 0,
      updated_at: 234_567,
      data: { info: { id: "msg_2", role: "assistant" }, parts: [{ type: "text", text: "changed" }] },
    })
  })
})
