import { describe, expect, test, vi } from "vitest"

import { createProjectionStore , type ProjectionStoreBackend } from "./projection-store"

function fakeSync() {
  return {
    // backend fakes keep `mode` for adapter parity.
    mode: () => "central_canonical" as const,
    sync_session_meta: vi.fn(async () => {}),
    sync_session_metas: vi.fn(async () => {}),
    sync_session_messages: vi.fn(async () => {}),
    put_session_meta: vi.fn(async () => {}),
    delete_session_meta: vi.fn(async () => {}),
    session_meta: vi.fn(async () => undefined),
    session_metas: vi.fn(async () => new Map()),
    list_session_metas: vi.fn(async () => []),
    tagged_session_metas: vi.fn(async () => []),
    persist_message_event: vi.fn(),
    read_session_messages: vi.fn(() => []),
    read_session_message_page: vi.fn(() => ({ messages: [], nextCursor: "next" })),
    read_session_max_event_ordinal: vi.fn(() => 0),
    subscribe_message_replay: vi.fn(() => () => {}),
  } satisfies ProjectionStoreBackend & { mode: () => "central_canonical"; [key: string]: unknown }
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
    await store.sync_session_messages(undefined, "session-1", [{ info: { id: "msg-1", role: "user" }, parts: [] }])
    store.read_session_messages("session-1")
    store.read_session_message_page?.("session-1", { limit: 80, before: "before" })
    store.read_session_max_event_ordinal("session-1")

    expect(sync.put_session_meta).toHaveBeenCalledWith("session-1", {
      directory: "/tmp/demo",
      title: "Demo",
    })
    expect(sync.sync_session_meta).toHaveBeenCalledWith(undefined, {
      id: "session-1",
      directory: "/tmp/demo",
    })
    expect(sync.sync_session_messages).toHaveBeenCalledWith(undefined, "session-1", [{
      info: { id: "msg-1", role: "user" },
      parts: [],
    }])
    expect(sync.read_session_messages).toHaveBeenCalledWith("session-1")
    expect(sync.read_session_message_page).toHaveBeenCalledWith("session-1", { limit: 80, before: "before" })
    expect(sync.read_session_max_event_ordinal).toHaveBeenCalledWith("session-1")
  })
})
