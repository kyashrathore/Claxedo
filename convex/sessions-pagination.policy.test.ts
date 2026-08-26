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
const harnesses = ["claude", "codex", "cursor", "claude-acp", "pi", "opencode"] as const

async function seedWorkspaceTranscripts(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      token_identifier: "token_owner",
      clerk_subject: "owner",
      created_at: 1,
      updated_at: 1,
    })
    const workspaceId = await ctx.db.insert("workspaces", {
      workspace_id: "ws_page",
      owner_user_id: userId,
      backing: "cloud-vm",
      access: "cloud",
      display_name: "Paged workspace",
      created_at: 1,
      updated_at: 1,
    })
    for (const harness of harnesses) {
      const sessionId = `session-${harness}`
      await ctx.db.insert("session_history", {
        session_id: sessionId,
        workspace_id: workspaceId,
        created_by_user_id: userId,
        created_at: 1,
        updated_at: 1,
      })
      for (let ordinal = 0; ordinal < 3; ordinal += 1) {
        await ctx.db.insert("session_messages", {
          session_id: sessionId,
          workspace_id: workspaceId,
          message_id: `${sessionId}-message-${ordinal + 1}`,
          role: ordinal % 2 === 0 ? "user" : "assistant",
          ordinal,
          data: {
            info: {
              id: `${sessionId}-message-${ordinal + 1}`,
              role: ordinal % 2 === 0 ? "user" : "assistant",
              harness,
            },
            parts: [],
          },
          created_at: ordinal + 1,
          updated_at: ordinal + 1,
        })
      }
    }
  })
}

describe("session message pagination", () => {
  test("applies one bounded chronological contract to every harness transcript", async () => {
    const t = convexTest(schema, modules)
    await seedWorkspaceTranscripts(t)
    const owner = t.withIdentity({ tokenIdentifier: "token_owner", subject: "owner" })

    for (const harness of harnesses) {
      const sessionId = `session-${harness}`
      const first = await owner.query(api.sessions.readMessages, {
        session_id: sessionId,
        workspace_id: "ws_page",
        limit: 2,
      })
      expect(first).toMatchObject({
        allowed: true,
        messages: [
          { info: { id: `${sessionId}-message-2`, harness } },
          { info: { id: `${sessionId}-message-3`, harness } },
        ],
        next_ordinal: 1,
      })
      if (!("next_ordinal" in first)) throw new Error(`missing next ordinal for ${harness}`)

      const older = await owner.query(api.sessions.readMessages, {
        session_id: sessionId,
        workspace_id: "ws_page",
        limit: 2,
        before_ordinal: first.next_ordinal,
      })
      expect(older).toMatchObject({
        allowed: true,
        messages: [{ info: { id: `${sessionId}-message-1`, harness } }],
      })
      expect(older).not.toHaveProperty("next_ordinal")
    }
  })

  test("keeps an unpaged authority read complete", async () => {
    const t = convexTest(schema, modules)
    await seedWorkspaceTranscripts(t)
    const owner = t.withIdentity({ tokenIdentifier: "token_owner", subject: "owner" })

    const result = await owner.query(api.sessions.readMessages, {
      session_id: "session-codex",
      workspace_id: "ws_page",
    })

    expect(result.messages.map((message) => (message as { info: { id: string } }).info.id)).toEqual([
      "session-codex-message-1",
      "session-codex-message-2",
      "session-codex-message-3",
    ])
    expect(result).not.toHaveProperty("next_ordinal")
  })
})
