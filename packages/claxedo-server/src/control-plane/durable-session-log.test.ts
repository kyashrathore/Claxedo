import { describe, expect, test, vi } from "vitest"
import type { SyncDB } from "../sync-db"
import { createDurableSessionLog } from "./durable-session-log"

function fakeSync() {
  return {
    mode: () => "central_canonical",
    sync_session_meta: vi.fn(async () => {}),
    sync_session_metas: vi.fn(async () => {}),
    put_session_meta: vi.fn(async () => {}),
    delete_session_meta: vi.fn(async () => {}),
    session_meta: vi.fn(async () => undefined),
    session_metas: vi.fn(async () => new Map()),
    list_session_metas: vi.fn(async () => []),
    tagged_session_metas: vi.fn(async () => []),
    persist_message_event: vi.fn(),
    read_session_messages: vi.fn(() => []),
    subscribe_message_replay: vi.fn(() => () => {}),
  } satisfies SyncDB
}

describe("durable session log", () => {
  test("delegates replay subscription and event persistence", () => {
    const sync = fakeSync()
    const log = createDurableSessionLog(sync)
    const bus = {
      subscribe: vi.fn(() => () => {}),
    }

    log.persist_message_event("session-1", {
      type: "message.updated",
      properties: { info: { id: "message-1" } },
    })
    const unsubscribe = log.subscribe_message_replay(bus)

    expect(sync.persist_message_event).toHaveBeenCalledWith("session-1", {
      type: "message.updated",
      properties: { info: { id: "message-1" } },
    })
    expect(sync.subscribe_message_replay).toHaveBeenCalledWith(bus)
    expect(typeof unsubscribe).toBe("function")
  })
})
