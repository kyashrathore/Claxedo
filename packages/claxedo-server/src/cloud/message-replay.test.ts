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

const root = path.join(realpathSync(os.tmpdir()), `message-replay-test-${randomUUID().slice(0, 8)}`)
const prev = {
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
}

process.env.CLAXEDO_DATA_DIR = root
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")

const [
  { persistMessageEvent, readSessionEventsAfter, readSessionMaxEventOrdinal, readSessionMessages, subscribeMessageReplay, terminalizeReplayMessages },
  { ClaxedoDB },
  { createBus },
  { ClaxedoCloudMessageTable, ClaxedoCloudSessionTable },
  { ClaxedoSessionMetaTable },
] = await Promise.all([
  import("./message-replay"),
  import("../storage/db"),
  import("../lib/bus"),
  import("../storage/cloud-session.sql"),
  import("../storage/session-meta.sql"),
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

  test("stores real workspace ids from session metadata when available", async () => {
    const now = Date.now()
    ClaxedoDB.use((db) => {
      db.insert(ClaxedoCloudSessionTable).values({
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
      }).run()
      db.insert(ClaxedoSessionMetaTable).values({
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
      }).run()
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

    expect(ClaxedoDB.use((db) => db.select().from(ClaxedoCloudMessageTable).all()))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ message_id: "msg_cloud_meta", workspace_id: "ws_cloud_meta" }),
        expect.objectContaining({ message_id: "msg_local_meta", workspace_id: "ws_local_meta" }),
      ]))
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
    const messages = terminalizeReplayMessages([{
      info: {
        id: "msg_1",
        sessionID: "sess_1",
        role: "assistant",
        time: { created: 100 },
      },
      parts: [{
        id: "tool_1",
        type: "tool",
        state: {
          status: "running",
          input: {},
          time: { start: 120 },
        },
      }],
    }], {
      interrupted: true,
      message: "ACP process restarted; pending interactive state must be rerun",
    })

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
          id: "p_1",
          sessionID: "sess_1",
          messageID: "msg_1",
          type: "text",
          text: "partial — now complete",
        },
      },
    })

    const messages = readSessionMessages("sess_1")
    expect(messages[0].parts).toHaveLength(1)
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

    expect(rows.map((row) => row.event_ordinal)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    )
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
