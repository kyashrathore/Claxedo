import { describe, expect, test, vi } from "vitest"
import type { SyncDB } from "../sync-db"
import { createProjectionStore } from "./projection-store"

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

describe("projection store", () => {
  test("delegates metadata writes and reads to the compatibility adapter", async () => {
    const sync = fakeSync()
    const store = createProjectionStore(sync)

    await store.put_session_meta("session-1", {
      directory: "/tmp/demo",
      title: "Demo",
    })
    await store.sync_session_meta(undefined, {
      id: "session-1",
      directory: "/tmp/demo",
    })
    store.read_session_messages("session-1")

    expect(sync.put_session_meta).toHaveBeenCalledWith("session-1", {
      directory: "/tmp/demo",
      title: "Demo",
    })
    expect(sync.sync_session_meta).toHaveBeenCalledWith(undefined, {
      id: "session-1",
      directory: "/tmp/demo",
    })
    expect(sync.read_session_messages).toHaveBeenCalledWith("session-1")
  })
})
