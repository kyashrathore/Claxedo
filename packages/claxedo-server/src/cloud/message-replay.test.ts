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
import fs from "fs/promises"
import path from "path"

const root = path.join(process.cwd(), ".tmp-message-replay-test")
const prev = {
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
}

process.env.CLAXEDO_DATA_DIR = root
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")

const [{ persistMessageEvent, readSessionMessages, subscribeMessageReplay }, { ClaxedoDB }, { createBus }] = await Promise.all([
  import("./message-replay"),
  import("../storage/db"),
  import("../bus"),
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

    // This is the key difference from syncCloudMessages — no ws.kind === "cloud" check
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

    // Simulate a cloud workspace event (comes from workspace-supervisor streamGlobal)
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
