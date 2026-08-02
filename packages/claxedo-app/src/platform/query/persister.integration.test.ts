import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { installQueryPersister, queryPersisterKey, resetQueryPersisterForTest } from "@/platform/query/persister"
import { queryKeys } from "@/platform/query/keys"

function storage() {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  }
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function historicalRuntimeMcpKey(baseUrl: string, directory: string) {
  return ["runtime", baseUrl.replace(/\/+$/, ""), "mcp", "", directory] as const
}

afterEach(() => {
  resetQueryPersisterForTest()
  queryClient.clear()
})

describe("query persister integration", () => {
  test("rehydrates directory and session data while excluding volatile runtime keys", async () => {
    const target = storage()
    await installQueryPersister({ storage: target, buster: "build-a", throttleTime: 0 })?.restore

    queryClient.setQueryData(queryKeys.directory.projectMeta("/tmp/ws"), { name: "Warm" })
    queryClient.setQueryData(queryKeys.directory.icon("/tmp/ws"), "triangle")
    queryClient.setQueryData(queryKeys.directory.sessionCache("/tmp/ws"), {
      at: 1,
      limit: 5,
      total: 1,
      session: [{ id: "ses_1", title: "Cached", time: { created: 1, updated: 2 } }],
    })
    queryClient.setQueryData(queryKeys.session.row(undefined, "/tmp/ws", "ses_1"), { id: "ses_1", title: "Cached" })
    queryClient.setQueryData(queryKeys.session.messages(undefined, "/tmp/ws", "ses_1"), {
      messages: [{ info: { id: "msg_1", sessionID: "ses_1" }, parts: [] }],
      maxEventOrdinal: 4,
    })
    queryClient.setQueryData(queryKeys.session.messages(undefined, "/tmp/ws", "ses_1", "cursor_1"), { ignoredCursor: true })
    queryClient.setQueryData(historicalRuntimeMcpKey("http://localhost:4096", "/tmp/ws"), { ignored: true })
    await tick()

    expect(target.getItem(queryPersisterKey)).toContain("Cached")
    expect(target.getItem(queryPersisterKey)).toContain("msg_1")
    expect(target.getItem(queryPersisterKey)).not.toContain("ignored")
    expect(target.getItem(queryPersisterKey)).not.toContain("ignoredCursor")

    resetQueryPersisterForTest()
    queryClient.clear()
    await installQueryPersister({ storage: target, buster: "build-a", throttleTime: 0 })?.restore

    expect(queryClient.getQueryData(queryKeys.directory.projectMeta("/tmp/ws"))).toEqual({ name: "Warm" })
    expect(queryClient.getQueryData(queryKeys.directory.icon("/tmp/ws"))).toBe("triangle")
    expect(queryClient.getQueryData(queryKeys.directory.sessionCache("/tmp/ws"))).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.session.row(undefined, "/tmp/ws", "ses_1"))).toEqual({ id: "ses_1", title: "Cached" })
    expect(queryClient.getQueryData(queryKeys.session.messages(undefined, "/tmp/ws", "ses_1"))).toMatchObject({ maxEventOrdinal: 4 })
    expect(queryClient.getQueryData(queryKeys.session.messages(undefined, "/tmp/ws", "ses_1", "cursor_1"))).toBeUndefined()
    expect(queryClient.getQueryData(historicalRuntimeMcpKey("http://localhost:4096", "/tmp/ws"))).toBeUndefined()

    resetQueryPersisterForTest()
    queryClient.clear()
    await installQueryPersister({ storage: target, buster: "build-b", throttleTime: 0 })?.restore

    expect(queryClient.getQueryData(queryKeys.directory.projectMeta("/tmp/ws"))).toBeUndefined()
    expect(target.getItem(queryPersisterKey)).toBeNull()
  })
})
