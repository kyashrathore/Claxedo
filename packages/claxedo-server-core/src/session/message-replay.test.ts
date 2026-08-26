/**
 * Message Replay Tests
 *
 * Verifies that:
 * 1. message.updated events persist message info to claxedo DB
 * 2. message.part.updated events persist parts
 * 3. readSessionMessages returns accumulated {info, parts} from DB
 * 4. Works for both local and cloud workspaces (no cloud guard)
 * 5. subscribeMessageReplay wires a bus so both local and cloud events persist
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import {
  AgentMessagePageError,
  LATEST_SURFACE_MAX_OPTIONAL_INFO_VALUE_BYTES,
  LATEST_SURFACE_MAX_TEXT_BYTES,
  LATEST_SURFACE_MAX_TEXT_PART_BYTES,
  LATEST_SURFACE_MAX_TEXT_PARTS,
} from "@claxedo/agent-sdk-runtime/message-page"
import { eq } from "drizzle-orm"

const root = path.join(realpathSync(os.tmpdir()), `message-replay-test-${randomUUID().slice(0, 8)}`)
const prev = {
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
}

process.env.CLAXEDO_DATA_DIR = root
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")

const [
  {
    persistMessageEvent,
    readSessionEventsAfter,
    readSessionMaxEventOrdinal,
    readSessionMessagePage,
    readSessionMessages,
    subscribeMessageReplay,
    terminalizeReplayMessages,
  },
  { ClaxedoDB },
  { createBus },
  { ClaxedoCloudMessageTable, ClaxedoCloudSessionTable },
  { ClaxedoSessionMetaTable },
] = await Promise.all([
  import("./message-replay"),
  import("../platform/db"),
  import("@claxedo/server-core/platform/runtime/lib/bus"),
  import("./cloud.sql"),
  import("@claxedo/server-core/session/meta.sql"),
])

beforeEach(async () => {
  await fs.mkdir(root, { recursive: true })
})

afterEach(async () => {
  ClaxedoDB.close()
  await fs.rm(root, { recursive: true, force: true })
})

afterAll(() => {
  if (prev.CLAXEDO_DATA_DIR !== undefined) process.env.CLAXEDO_DATA_DIR = prev.CLAXEDO_DATA_DIR
  else delete process.env.CLAXEDO_DATA_DIR
  if (prev.CLAXEDO_STATE_DIR !== undefined) process.env.CLAXEDO_STATE_DIR = prev.CLAXEDO_STATE_DIR
  else delete process.env.CLAXEDO_STATE_DIR
})

describe("message replay", () => {
  test("persists message.updated event and reads it back", async () => {
    persistMessageEvent("sess_1", {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_1",
          sessionID: "sess_1",
          role: "user",
          created: 100,
          updated: 100,
        },
      },
    })

    const messages = readSessionMessages("sess_1")
    expect(messages).toHaveLength(1)
    expect(messages[0].info.id).toBe("msg_1")
    expect(messages[0].info.role).toBe("user")
    expect(messages[0].parts).toEqual([])
  })

  test("reads bounded newest-first pages and returns each page chronologically", () => {
    for (let index = 1; index <= 6; index += 1) {
      persistMessageEvent("sess_page", {
        type: "message.updated",
        properties: {
          info: {
            id: `msg_${index}`,
            sessionID: "sess_page",
            role: index % 2 === 0 ? "assistant" : "user",
            time: { created: index },
          },
        },
      })
    }

    const first = readSessionMessagePage("sess_page", { limit: 2 })
    expect(first.messages.map((message) => message.info.id)).toEqual(["msg_5", "msg_6"])
    expect(first.nextCursor).toMatch(/^cspm1:/)

    const second = readSessionMessagePage("sess_page", { limit: 2, before: first.nextCursor })
    expect(second.messages.map((message) => message.info.id)).toEqual(["msg_3", "msg_4"])
    expect(second.nextCursor).toMatch(/^cspm1:/)

    const third = readSessionMessagePage("sess_page", { limit: 2, before: second.nextCursor })
    expect(third.messages.map((message) => message.info.id)).toEqual(["msg_1", "msg_2"])
    expect(third.nextCursor).toBeUndefined()
  })

  test("reads the authoritative latest user turn and pages older history without overlap", () => {
    const roles = ["user", "assistant", "assistant", "user", "assistant", "assistant"] as const
    roles.forEach((role, index) => {
      persistMessageEvent("sess_latest_turn", {
        type: "message.updated",
        properties: {
          info: {
            id: `latest_${index + 1}`,
            sessionID: "sess_latest_turn",
            role,
            ...(role === "assistant" ? { parentID: index < 3 ? "latest_1" : "latest_4" } : {}),
            time: { created: index + 1 },
          },
        },
      })
    })

    const latest = readSessionMessagePage("sess_latest_turn", { view: "latest-turn" })
    expect(latest.messages.map((message) => message.info.id)).toEqual(["latest_4", "latest_5", "latest_6"])
    expect(latest.nextCursor).toMatch(/^cspm1:/)

    const older = readSessionMessagePage("sess_latest_turn", { limit: 20, before: latest.nextCursor })
    expect(older.messages.map((message) => message.info.id)).toEqual(["latest_1", "latest_2", "latest_3"])
    expect(older.nextCursor).toBeUndefined()
  })

  test("reads a bounded latest surface and keeps omitted turn messages reachable", () => {
    const omittedDecodeMarker = "LATEST_SURFACE_OMITTED_PAYLOAD_MUST_NOT_BE_PARSED"
    const omittedPayload = `${omittedDecodeMarker}:${"x".repeat(256 * 1024)}`
    const roles = ["user", "assistant", "user", "assistant", "assistant"] as const
    roles.forEach((role, index) => {
      persistMessageEvent("sess_latest_surface", {
        type: "message.updated",
        properties: {
          info: {
            id: `surface_${index + 1}`,
            sessionID: "sess_latest_surface",
            role,
            ...(role === "assistant" ? { parentID: index < 2 ? "surface_1" : "surface_3" } : {}),
            time: { created: index + 1 },
            ...(index === 2
              ? {
                  summary: { body: "deferred summary", diffs: [{ patch: "large diff" }] },
                  system: omittedPayload,
                  tools: { read: true },
                  agent: "build",
                  model: { providerID: "provider", modelID: "model" },
                }
              : {}),
          },
        },
      })
    })
    for (const part of [
      { id: "surface_user_text", messageID: "surface_3", type: "text", text: "complete prompt" },
      { id: "surface_user_file", messageID: "surface_3", type: "file", url: "data:large" },
      { id: "surface_final_reasoning", messageID: "surface_5", type: "reasoning", text: "large reasoning" },
      { id: "surface_final_text", messageID: "surface_5", type: "text", text: "complete final reply" },
      {
        id: "surface_final_tool",
        messageID: "surface_5",
        type: "tool",
        state: { status: "completed", output: omittedPayload },
      },
    ]) {
      persistMessageEvent("sess_latest_surface", {
        type: "message.part.updated",
        properties: { part: { sessionID: "sess_latest_surface", ...part } },
      })
    }

    const originalParse = JSON.parse
    JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
      expect(text).not.toContain(omittedDecodeMarker)
      return originalParse(text, reviver)
    }) as typeof JSON.parse
    let surface: ReturnType<typeof readSessionMessagePage>
    try {
      surface = readSessionMessagePage("sess_latest_surface", { view: "latest-surface" })
    } finally {
      JSON.parse = originalParse
    }
    expect(surface.messages.map((message) => message.info.id)).toEqual(["surface_3", "surface_5"])
    expect(surface.messages[0]?.info).toEqual({
      id: "surface_3",
      sessionID: "sess_latest_surface",
      role: "user",
      time: { created: 3 },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    })
    expect(surface.messages.map((message) => message.parts)).toEqual([
      [
        {
          id: "surface_user_text",
          sessionID: "sess_latest_surface",
          messageID: "surface_3",
          type: "text",
          text: "complete prompt",
        },
      ],
      [
        {
          id: "surface_final_text",
          sessionID: "sess_latest_surface",
          messageID: "surface_5",
          type: "text",
          text: "complete final reply",
        },
      ],
    ])
    expect(surface.nextCursor).toMatch(/^cspm1:/)

    const complete = readSessionMessagePage("sess_latest_surface", { view: "latest-turn" })
    expect(complete.messages[0]?.info.summary).toEqual({ body: "deferred summary", diffs: [{ patch: "large diff" }] })
    expect(complete.messages.at(-1)?.parts.map((part) => part.type)).toEqual(["reasoning", "text", "tool"])

    const older = readSessionMessagePage("sess_latest_surface", { limit: 20, before: surface.nextCursor })
    expect(older.messages.map((message) => message.info.id)).toEqual([
      "surface_1",
      "surface_2",
      "surface_3",
      "surface_4",
    ])
  })

  test("bounds oversized user/assistant text, assistant errors, and many small parts while latest-turn stays complete", () => {
    const sessionID = "sess_surface_budget"
    const oversizedUser = "u".repeat(LATEST_SURFACE_MAX_TEXT_PART_BYTES + 1)
    const oversizedAssistant = "a".repeat(LATEST_SURFACE_MAX_TEXT_PART_BYTES + 1)
    const error = { name: "ProviderError", data: { body: "e".repeat(LATEST_SURFACE_MAX_OPTIONAL_INFO_VALUE_BYTES) } }
    const chunk = "x".repeat(Math.floor(LATEST_SURFACE_MAX_TEXT_BYTES / LATEST_SURFACE_MAX_TEXT_PARTS) - 256)
    for (const info of [
      { id: "budget-user", sessionID, role: "user", time: { created: 1 } },
      { id: "budget-assistant", sessionID, role: "assistant", parentID: "budget-user", time: { created: 2 }, error },
    ]) {
      persistMessageEvent(sessionID, { type: "message.updated", properties: { info } })
    }
    const parts = [
      { id: "budget-user-oversized", messageID: "budget-user", type: "text", text: oversizedUser },
      { id: "budget-assistant-oversized", messageID: "budget-assistant", type: "text", text: oversizedAssistant },
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `budget-small-${index}`,
        messageID: "budget-assistant",
        type: "text",
        text: chunk,
      })),
    ]
    for (const part of parts) {
      persistMessageEvent(sessionID, {
        type: "message.part.updated",
        properties: { part: { sessionID, ...part } },
      })
    }

    const surface = readSessionMessagePage(sessionID, { view: "latest-surface" })
    expect(surface.messages[0]?.parts).toEqual([])
    expect(surface.messages[1]?.info.error).toBeUndefined()
    expect(surface.messages[1]?.parts.map((part) => part.id)).toEqual(
      Array.from({ length: LATEST_SURFACE_MAX_TEXT_PARTS }, (_, index) => `budget-small-${index + 4}`),
    )

    const complete = readSessionMessagePage(sessionID, { view: "latest-turn" })
    expect(complete.messages[0]?.parts[0]?.text).toBe(oversizedUser)
    expect(complete.messages[1]?.parts[0]?.text).toBe(oversizedAssistant)
    expect(complete.messages[1]?.info.error).toEqual(error)
    expect(complete.messages[1]?.parts).toHaveLength(21)
  })

  test("does not invent a surface cursor for an adjacent user and final assistant", () => {
    for (const info of [
      { id: "adjacent_user", sessionID: "sess_adjacent", role: "user" },
      {
        id: "adjacent_assistant",
        sessionID: "sess_adjacent",
        role: "assistant",
        parentID: "adjacent_user",
      },
    ]) {
      persistMessageEvent("sess_adjacent", { type: "message.updated", properties: { info } })
    }

    const surface = readSessionMessagePage("sess_adjacent", { view: "latest-surface" })
    expect(surface.messages.map((message) => message.info.id)).toEqual(["adjacent_user", "adjacent_assistant"])
    expect(surface.nextCursor).toBeUndefined()
  })

  test("excludes part-only placeholders from semantic reads", () => {
    persistMessageEvent("sess_placeholder", {
      type: "message.updated",
      properties: { info: { id: "placeholder_user", sessionID: "sess_placeholder", role: "user" } },
    })
    persistMessageEvent("sess_placeholder", {
      type: "message.updated",
      properties: {
        info: {
          id: "placeholder_assistant",
          sessionID: "sess_placeholder",
          role: "assistant",
          parentID: "placeholder_user",
        },
      },
    })
    persistMessageEvent("sess_placeholder", {
      type: "message.part.updated",
      properties: {
        part: {
          id: "early_part",
          sessionID: "sess_placeholder",
          messageID: "part_only_message",
          type: "text",
          text: "not yet authoritative",
        },
      },
    })

    for (const view of ["latest-turn", "latest-surface"] as const) {
      const page = readSessionMessagePage("sess_placeholder", { view })
      expect(page.messages.map((message) => message.info.id)).toEqual([
        "placeholder_user",
        "placeholder_assistant",
      ])
      expect(page.nextCursor).toBeUndefined()
    }
  })

  test("promotes an early part placeholder when its authoritative message arrives", () => {
    persistMessageEvent("sess_promoted", {
      type: "message.updated",
      properties: { info: { id: "promoted_user", sessionID: "sess_promoted", role: "user" } },
    })
    persistMessageEvent("sess_promoted", {
      type: "message.part.updated",
      properties: {
        part: {
          id: "promoted_part",
          sessionID: "sess_promoted",
          messageID: "promoted_assistant",
          type: "text",
          text: "arrived first",
        },
      },
    })
    persistMessageEvent("sess_promoted", {
      type: "message.updated",
      properties: {
        info: {
          id: "promoted_assistant",
          sessionID: "sess_promoted",
          role: "assistant",
          parentID: "promoted_user",
        },
      },
    })

    const latest = readSessionMessagePage("sess_promoted", { view: "latest-turn" })
    expect(latest.messages.map((message) => message.info.id)).toEqual(["promoted_user", "promoted_assistant"])
    expect(latest.messages.at(-1)?.parts.map((part) => part.id)).toEqual(["promoted_part"])
  })

  test("rejects a semantic turn whose assistant is owned by another user", () => {
    persistMessageEvent("sess_wrong_owner", {
      type: "message.updated",
      properties: { info: { id: "owner_user", sessionID: "sess_wrong_owner", role: "user" } },
    })
    persistMessageEvent("sess_wrong_owner", {
      type: "message.updated",
      properties: {
        info: {
          id: "wrong_assistant",
          sessionID: "sess_wrong_owner",
          role: "assistant",
          parentID: "different_user",
        },
      },
    })

    for (const view of ["latest-turn", "latest-surface"] as const) {
      expect(() => readSessionMessagePage("sess_wrong_owner", { view })).toThrowError(AgentMessagePageError)
    }
  })

  test("binds opaque page cursors to their session and rejects malformed inputs", () => {
    for (const sessionID of ["sess_a", "sess_b"]) {
      for (let index = 1; index <= 2; index += 1) {
        persistMessageEvent(sessionID, {
          type: "message.updated",
          properties: {
            info: { id: `${sessionID}_${index}`, sessionID, role: "user" },
          },
        })
      }
    }
    const cursor = readSessionMessagePage("sess_a", { limit: 1 }).nextCursor
    expect(cursor).toBeTruthy()

    for (const read of [
      () => readSessionMessagePage("sess_a", { limit: 1, before: "not-a-cursor" }),
      () => readSessionMessagePage("sess_b", { limit: 1, before: cursor }),
      () => readSessionMessagePage("sess_a", { limit: 0 }),
      () => readSessionMessagePage("sess_a", { limit: 501 }),
    ]) {
      expect(read).toThrow(AgentMessagePageError)
    }
  })

  test("does not parse messages outside the bounded selection", () => {
    for (let index = 1; index <= 3; index += 1) {
      persistMessageEvent("sess_bounded", {
        type: "message.updated",
        properties: {
          info: { id: `bounded_${index}`, sessionID: "sess_bounded", role: "user" },
        },
      })
    }
    ClaxedoDB.use((db) =>
      db
        .update(ClaxedoCloudMessageTable)
        .set({ data: "not-json" })
        .where(eq(ClaxedoCloudMessageTable.message_id, "bounded_1"))
        .run(),
    )

    expect(readSessionMessagePage("sess_bounded", { limit: 1 }).messages.map((message) => message.info.id)).toEqual([
      "bounded_3",
    ])
    expect(() => readSessionMessages("sess_bounded")).toThrow()
  })

  test("stores real workspace ids from session metadata when available", async () => {
    const now = Date.now()
    ClaxedoDB.use((db) => {
      db.insert(ClaxedoCloudSessionTable)
        .values({
          session_id: "cloud_sess_meta",
          workspace_id: "ws_cloud_meta",
          project_id: "proj_cloud",
          directory: "/workspace",
          title: null,
          driver: "daytona",
          repo_name: null,
          git_branch: null,
          git_remote: null,
          data: "{}",
          created_at: now,
          updated_at: now,
          deleted_at: null,
        })
        .run()
      db.insert(ClaxedoSessionMetaTable)
        .values({
          session_ref: "workspace:ws_local_meta:session:local_sess_meta",
          session_id: "local_sess_meta",
          workspace_id: "ws_local_meta",
          project_id: "proj_local",
          directory: "/repo",
          title: null,
          parent_session_id: null,
          archived_at: null,
          created_at: now,
          updated_at: now,
        })
        .run()
    })

    persistMessageEvent("cloud_sess_meta", {
      type: "message.updated",
      properties: {
        info: { id: "msg_cloud_meta", sessionID: "cloud_sess_meta", role: "assistant" },
      },
    })
    persistMessageEvent("local_sess_meta", {
      type: "message.updated",
      properties: {
        info: { id: "msg_local_meta", sessionID: "local_sess_meta", role: "user" },
      },
    })

    expect(ClaxedoDB.use((db) => db.select().from(ClaxedoCloudMessageTable).all())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message_id: "msg_cloud_meta", workspace_id: "ws_cloud_meta" }),
        expect.objectContaining({ message_id: "msg_local_meta", workspace_id: "ws_local_meta" }),
      ]),
    )
  })

  test("persists message.part.updated and attaches parts to message", async () => {
    persistMessageEvent("sess_1", {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_1",
          sessionID: "sess_1",
          role: "assistant",
          created: 100,
          updated: 100,
        },
      },
    })

    persistMessageEvent("sess_1", {
      type: "message.part.updated",
      properties: {
        part: {
          id: "p_1",
          sessionID: "sess_1",
          messageID: "msg_1",
          type: "text",
          text: "Hello world",
        },
      },
    })

    const messages = readSessionMessages("sess_1")
    expect(messages).toHaveLength(1)
    expect(messages[0].parts).toHaveLength(1)
    expect(messages[0].parts[0].type).toBe("text")
    expect(messages[0].parts[0].text).toBe("Hello world")
  })

  test("terminalizes running tools when replaying interrupted ACP sessions", () => {
    const messages = terminalizeReplayMessages(
      [
        {
          info: {
            id: "msg_1",
            sessionID: "sess_1",
            role: "assistant",
            time: { created: 100 },
          },
          parts: [
            {
              id: "tool_1",
              type: "tool",
              state: {
                status: "running",
                input: {},
                time: { start: 120 },
              },
            },
          ],
        },
      ],
      {
        interrupted: true,
        message: "ACP process restarted; pending interactive state must be rerun",
      },
    )

    expect(messages[0].parts[0].state).toMatchObject({
      status: "error",
      error: "Tool execution interrupted by ACP restart",
      time: { start: 120, end: 100 },
    })
  })

  test("accumulates message.part.delta text after an empty part shell", async () => {
    persistMessageEvent("sess_1", {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_1",
          sessionID: "sess_1",
          role: "assistant",
          created: 100,
          updated: 100,
        },
      },
    })

    persistMessageEvent("sess_1", {
      type: "message.part.updated",
      properties: {
        part: {
          id: "p_1",
          sessionID: "sess_1",
          messageID: "msg_1",
          type: "text",
          text: "",
        },
      },
    })

    persistMessageEvent("sess_1", {
      type: "message.part.delta",
      properties: {
        sessionID: "sess_1",
        messageID: "msg_1",
        partID: "p_1",
        field: "text",
        delta: "Hello",
      },
    } as any)

    persistMessageEvent("sess_1", {
      type: "message.part.delta",
      properties: {
        sessionID: "sess_1",
        messageID: "msg_1",
        partID: "p_1",
        field: "text",
        delta: " world",
      },
    } as any)

    const messages = readSessionMessages("sess_1")
    expect(messages[0].parts[0].text).toBe("Hello world")
  })

  test("upserts parts on repeated message.part.updated", async () => {
    persistMessageEvent("sess_1", {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_1",
          sessionID: "sess_1",
          role: "assistant",
          created: 100,
          updated: 100,
        },
      },
    })

    persistMessageEvent("sess_1", {
      type: "message.part.updated",
      properties: {
        part: {
          id: "p_1",
          sessionID: "sess_1",
          messageID: "msg_1",
          type: "text",
          text: "partial",
        },
      },
    })

    persistMessageEvent("sess_1", {
      type: "message.part.updated",
      properties: {
        part: {
          id: "p_2",
          sessionID: "sess_1",
          messageID: "msg_1",
          type: "text",
          text: "second",
        },
      },
    })

    persistMessageEvent("sess_1", {
      type: "message.part.updated",
      properties: {
        part: {
          id: "p_1",
          sessionID: "sess_1",
          messageID: "msg_1",
          type: "text",
          text: "partial — now complete",
        },
      },
    })

    const messages = readSessionMessages("sess_1")
    expect(messages[0].parts.map((part) => part.id)).toEqual(["p_1", "p_2"])
    expect(messages[0].parts[0].text).toBe("partial — now complete")
  })

  test("keeps parts even when message.part.updated arrives before message.updated", async () => {
    persistMessageEvent("sess_1", {
      type: "message.part.updated",
      properties: {
        part: {
          id: "p_early",
          sessionID: "sess_1",
          messageID: "msg_early",
          type: "text",
          text: "arrived first",
        },
      },
    })

    persistMessageEvent("sess_1", {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_early",
          sessionID: "sess_1",
          role: "assistant",
          created: 100,
          updated: 100,
        },
      },
    })

    const messages = readSessionMessages("sess_1")
    expect(messages).toHaveLength(1)
    expect(messages[0].parts).toHaveLength(1)
    expect(messages[0].parts[0].id).toBe("p_early")
  })

  test("preserves message ordering", async () => {
    persistMessageEvent("sess_1", {
      type: "message.updated",
      properties: {
        info: { id: "msg_user", sessionID: "sess_1", role: "user", created: 100, updated: 100 },
      },
    })
    persistMessageEvent("sess_1", {
      type: "message.updated",
      properties: {
        info: { id: "msg_asst", sessionID: "sess_1", role: "assistant", created: 200, updated: 200 },
      },
    })

    const messages = readSessionMessages("sess_1")
    expect(messages).toHaveLength(2)
    expect(messages[0].info.id).toBe("msg_user")
    expect(messages[1].info.id).toBe("msg_asst")
  })

  test("stamps monotonic event_ordinal for concurrent writes in one session", async () => {
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        Promise.resolve().then(() => {
          persistMessageEvent("sess_concurrent", {
            type: "message.updated",
            properties: {
              info: {
                id: `msg_${index.toString().padStart(3, "0")}`,
                sessionID: "sess_concurrent",
                role: "assistant",
                created: index,
                updated: index,
              },
            },
          })
        }),
      ),
    )

    const rows = ClaxedoDB.raw()
      .prepare(
        `
        SELECT event_ordinal
        FROM claxedo_cloud_message
        WHERE session_id = ?
        ORDER BY event_ordinal
        `,
      )
      .all("sess_concurrent") as { event_ordinal: number }[]

    expect(rows.map((row) => row.event_ordinal)).toEqual(Array.from({ length: 100 }, (_, index) => index + 1))
  })

  test("live event ordinals continue after pulled snapshot revisions", async () => {
    ClaxedoDB.raw()
      .prepare(
        `
        INSERT INTO claxedo_cloud_message (
          message_id,
          session_id,
          workspace_id,
          role,
          ordinal,
          event_ordinal,
          data,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        "msg_snapshot",
        "sess_snapshot",
        "ws_1",
        "assistant",
        0,
        12,
        JSON.stringify({ info: { id: "msg_snapshot", role: "assistant" }, parts: [] }),
        1,
        1,
      )

    expect(readSessionMaxEventOrdinal("sess_snapshot")).toBe(12)

    persistMessageEvent("sess_snapshot", {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_live",
          sessionID: "sess_snapshot",
          role: "assistant",
        },
      },
    })

    expect(readSessionEventsAfter("sess_snapshot", 12).map((event) => event.event_ordinal)).toEqual([13])
    expect(readSessionMaxEventOrdinal("sess_snapshot")).toBe(13)
  })

  test("invalid message events do not consume event_ordinal", async () => {
    persistMessageEvent("sess_invalid", {
      type: "message.updated",
      properties: {
        info: {
          sessionID: "sess_invalid",
          role: "assistant",
        },
      },
    })
    persistMessageEvent("sess_invalid", {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_valid",
          sessionID: "sess_invalid",
          role: "assistant",
        },
      },
    })

    const row = ClaxedoDB.raw()
      .prepare("SELECT event_ordinal FROM claxedo_cloud_message WHERE session_id = ?")
      .get("sess_invalid") as { event_ordinal: number }

    expect(row.event_ordinal).toBe(1)
  })

  test("reads session events after an ordinal in ascending order", async () => {
    Array.from({ length: 10 }, (_, index) => {
      persistMessageEvent("sess_replay", {
        type: "message.updated",
        properties: {
          info: {
            id: `msg_${index + 1}`,
            sessionID: "sess_replay",
            role: "assistant",
          },
        },
      })
    })

    const events = readSessionEventsAfter("sess_replay", 5)

    expect(events.map((event) => event.event_ordinal)).toEqual([6, 7, 8, 9, 10])
    expect(events.map((event) => event.type)).toEqual(Array(5).fill("message.updated"))
    expect(events[0].properties?.info).toMatchObject({ id: "msg_6" })
  })

  test("readSessionEventsAfter isolates sessions and returns empty past the tail", async () => {
    Array.from({ length: 3 }, (_, index) => {
      persistMessageEvent("sess_replay_a", {
        type: "message.updated",
        properties: {
          info: {
            id: `msg_a_${index + 1}`,
            sessionID: "sess_replay_a",
            role: "assistant",
          },
        },
      })
      persistMessageEvent("sess_replay_b", {
        type: "message.updated",
        properties: {
          info: {
            id: `msg_b_${index + 1}`,
            sessionID: "sess_replay_b",
            role: "assistant",
          },
        },
      })
    })

    expect(readSessionEventsAfter("sess_replay_a", 1).map((event) => event.properties?.info)).toEqual([
      expect.objectContaining({ id: "msg_a_2" }),
      expect.objectContaining({ id: "msg_a_3" }),
    ])
    expect(readSessionEventsAfter("sess_replay_b", 3)).toEqual([])
  })

  test("isolates messages by session", async () => {
    persistMessageEvent("sess_1", {
      type: "message.updated",
      properties: {
        info: { id: "msg_a", sessionID: "sess_1", role: "user", created: 100, updated: 100 },
      },
    })
    persistMessageEvent("sess_2", {
      type: "message.updated",
      properties: {
        info: { id: "msg_b", sessionID: "sess_2", role: "user", created: 100, updated: 100 },
      },
    })

    expect(readSessionMessages("sess_1")).toHaveLength(1)
    expect(readSessionMessages("sess_2")).toHaveLength(1)
    expect(readSessionMessages("sess_1")[0].info.id).toBe("msg_a")
  })

  test("ignores non-message events", async () => {
    persistMessageEvent("sess_1", {
      type: "session.idle",
      properties: { sessionID: "sess_1" },
    } as any)

    expect(readSessionMessages("sess_1")).toHaveLength(0)
  })

  test("works for local workspace (no cloud guard)", async () => {
    await fs.mkdir(root, { recursive: true })

    // Replay persistence is workspace-agnostic here; the global bus is the convergence point
    persistMessageEvent("local_sess", {
      type: "message.updated",
      properties: {
        info: { id: "msg_local", sessionID: "local_sess", role: "user", created: 100, updated: 100 },
      },
    })

    const messages = readSessionMessages("local_sess")
    expect(messages).toHaveLength(1)
    expect(messages[0].info.id).toBe("msg_local")
  })
})

describe("subscribeMessageReplay", () => {
  test("persists message.updated events published on the bus", () => {
    const bus = createBus<{ directory?: string; payload: { type: string; properties?: Record<string, unknown> } }>()
    const unsub = subscribeMessageReplay(bus)

    bus.publish({
      directory: "/some/local/dir",
      payload: {
        type: "message.updated",
        properties: {
          info: { id: "msg_bus_1", sessionID: "bus_sess", role: "user", created: 100, updated: 100 },
        },
      },
    })

    const messages = readSessionMessages("bus_sess")
    expect(messages).toHaveLength(1)
    expect(messages[0].info.id).toBe("msg_bus_1")
    unsub()
  })

  test("persists message.part.updated events published on the bus", () => {
    const bus = createBus<{ directory?: string; payload: { type: string; properties?: Record<string, unknown> } }>()
    const unsub = subscribeMessageReplay(bus)

    // First create the message
    bus.publish({
      directory: "/dir",
      payload: {
        type: "message.updated",
        properties: {
          info: { id: "msg_bus_2", sessionID: "bus_sess_2", role: "assistant", created: 100, updated: 100 },
        },
      },
    })

    // Then add a part
    bus.publish({
      directory: "/dir",
      payload: {
        type: "message.part.updated",
        properties: {
          part: { id: "p_1", sessionID: "bus_sess_2", messageID: "msg_bus_2", type: "text", text: "hello" },
        },
      },
    })

    const messages = readSessionMessages("bus_sess_2")
    expect(messages).toHaveLength(1)
    expect(messages[0].parts).toHaveLength(1)
    expect(messages[0].parts[0].text).toBe("hello")
    unsub()
  })

  test("persists message.part.delta events published on the bus", () => {
    const bus = createBus<{ directory?: string; payload: { type: string; properties?: Record<string, unknown> } }>()
    const unsub = subscribeMessageReplay(bus)

    bus.publish({
      directory: "/dir",
      payload: {
        type: "message.updated",
        properties: {
          info: { id: "msg_bus_3", sessionID: "bus_sess_3", role: "assistant", created: 100, updated: 100 },
        },
      },
    })

    bus.publish({
      directory: "/dir",
      payload: {
        type: "message.part.updated",
        properties: {
          part: { id: "p_1", sessionID: "bus_sess_3", messageID: "msg_bus_3", type: "text", text: "" },
        },
      },
    })

    bus.publish({
      directory: "/dir",
      payload: {
        type: "message.part.delta",
        properties: {
          sessionID: "bus_sess_3",
          messageID: "msg_bus_3",
          partID: "p_1",
          field: "text",
          delta: "hello",
        },
      },
    })

    const messages = readSessionMessages("bus_sess_3")
    expect(messages[0].parts[0].text).toBe("hello")
    unsub()
  })

  test("ignores non-message events on the bus", () => {
    const bus = createBus<{ directory?: string; payload: { type: string; properties?: Record<string, unknown> } }>()
    const unsub = subscribeMessageReplay(bus)

    bus.publish({
      directory: "/dir",
      payload: { type: "session.idle", properties: { sessionID: "bus_sess_3" } },
    })

    expect(readSessionMessages("bus_sess_3")).toHaveLength(0)
    unsub()
  })

  test("works for cloud workspace events (same bus, different origin)", () => {
    const bus = createBus<{ directory?: string; payload: { type: string; properties?: Record<string, unknown> } }>()
    const unsub = subscribeMessageReplay(bus)

    // Simulate a cloud workspace compatibility event after it has entered this process' bus.
    bus.publish({
      directory: "/remote/sandbox/dir",
      payload: {
        type: "message.updated",
        properties: {
          info: { id: "msg_cloud", sessionID: "cloud_sess", role: "assistant", created: 200, updated: 200 },
        },
      },
    })

    const messages = readSessionMessages("cloud_sess")
    expect(messages).toHaveLength(1)
    expect(messages[0].info.id).toBe("msg_cloud")
    unsub()
  })

  test("returns unsubscribe function that stops persistence", () => {
    const bus = createBus<{ directory?: string; payload: { type: string; properties?: Record<string, unknown> } }>()
    const unsub = subscribeMessageReplay(bus)

    bus.publish({
      directory: "/dir",
      payload: {
        type: "message.updated",
        properties: {
          info: { id: "msg_before", sessionID: "unsub_sess", role: "user", created: 100, updated: 100 },
        },
      },
    })

    unsub()

    bus.publish({
      directory: "/dir",
      payload: {
        type: "message.updated",
        properties: {
          info: { id: "msg_after", sessionID: "unsub_sess", role: "assistant", created: 200, updated: 200 },
        },
      },
    })

    const messages = readSessionMessages("unsub_sess")
    expect(messages).toHaveLength(1)
    expect(messages[0].info.id).toBe("msg_before")
  })
})
