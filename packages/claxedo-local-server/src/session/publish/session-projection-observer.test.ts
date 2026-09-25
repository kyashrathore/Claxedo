import { describe, expect, test, vi } from "vitest"
import type { SessionMeta } from "@claxedo/server-core/session/meta/index"
import { observedSessionProjectionStore } from "./session-projection-observer"

function meta(sessionID: string, workspaceID?: string): SessionMeta {
  return { sessionID, host: "workspace", createdAt: 1, updatedAt: 1, tags: [], attachments: [], ...(workspaceID ? { workspaceID } : {}) }
}

function harness(rows: Record<string, SessionMeta | undefined>) {
  const store = {
    put_session_meta: vi.fn(async (_sessionID: string, _input: Record<string, unknown>) => {}),
    delete_session_meta: vi.fn(async (_sessionID: string) => {}),
    sync_session_meta: vi.fn(async (_ws: unknown, _input: unknown) => {}),
    sync_session_metas: vi.fn(async (_ws: unknown, _input: unknown[]) => {}),
    session_meta: vi.fn(async (sessionID: string) => rows[sessionID]),
    list_session_metas: vi.fn(async () => []),
  }
  const observer = { sessionChanged: vi.fn(), sessionRemoved: vi.fn(), workspaceChanged: vi.fn() }
  return { store, observer, observed: observedSessionProjectionStore(store, observer) }
}

const ws = { id: "ws_a", directory: "/work", kind: "local" as const, created_at: 0, updated_at: 0 }

describe("the observed projection store", () => {
  test("reports a put after it lands, under the workspace the row now names", async () => {
    const h = harness({ s1: meta("s1", "ws_a") })
    await h.observed.put_session_meta("s1", { title: "t" })

    expect(h.store.put_session_meta).toHaveBeenCalledWith("s1", { title: "t" })
    expect(h.observer.sessionChanged).toHaveBeenCalledWith("ws_a", "s1")
  })

  test("reports a synced session and a synced snapshot", async () => {
    const h = harness({ s2: meta("s2", "ws_a") })
    await h.observed.sync_session_meta(ws, { id: "s2", title: "t" })
    await h.observed.sync_session_metas(ws, [{ id: "s2" }])
    await h.observed.sync_session_metas(undefined, [{ id: "s2" }])

    expect(h.observer.sessionChanged).toHaveBeenCalledWith("ws_a", "s2")
    expect(h.observer.workspaceChanged).toHaveBeenCalledTimes(1)
    expect(h.observer.workspaceChanged).toHaveBeenCalledWith("ws_a")
  })

  test("reports a delete under the workspace the row named before it went", async () => {
    const h = harness({ s3: meta("s3", "ws_a") })
    await h.observed.delete_session_meta("s3")

    expect(h.store.delete_session_meta).toHaveBeenCalledWith("s3")
    expect(h.observer.sessionRemoved).toHaveBeenCalledWith("ws_a", "s3")
  })

  test("a row with no workspace is nobody's to publish", async () => {
    const h = harness({ s4: meta("s4") })
    await h.observed.put_session_meta("s4", {})
    await h.observed.delete_session_meta("s4")

    expect(h.observer.sessionChanged).not.toHaveBeenCalled()
    expect(h.observer.sessionRemoved).not.toHaveBeenCalled()
  })

  test("a report that throws never fails the write", async () => {
    const h = harness({ s5: meta("s5", "ws_a") })
    h.observer.sessionChanged.mockImplementation(() => {
      throw new Error("publisher down")
    })
    h.store.session_meta.mockRejectedValueOnce(new Error("read failed"))

    await expect(h.observed.put_session_meta("s5", {})).resolves.toBeUndefined()
    await expect(h.observed.put_session_meta("s5", {})).resolves.toBeUndefined()
    expect(h.store.put_session_meta).toHaveBeenCalledTimes(2)
  })

  test("the rest of the store is the store", () => {
    const h = harness({})
    expect(h.observed.list_session_metas).toBe(h.store.list_session_metas)
  })
})
