import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "./query-client"
import {
  installQueryPersister,
  queryPersistencePolicies,
  queryPersisterKey,
  resetQueryPersisterForTest,
  shouldDehydrateQuery,
} from "./persister"

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

afterEach(() => {
  resetQueryPersisterForTest()
  queryClient.clear()
})

describe("query persister", () => {
  test("documents every persisted query family with ownership and deletion conditions", () => {
    expect(queryPersistencePolicies.map((policy) => policy.id)).toEqual([
      "control-plane.cache",
      "shell.commands-cache",
      "directory.cache",
      "session.stable-head",
      "runtime.workspace-cache",
    ])
    expect(
      queryPersistencePolicies.every((policy) =>
        policy.owner &&
        policy.scope &&
        policy.reason &&
        policy.deletionCondition,
      ),
    ).toBe(true)
  })

  test("dehydrates only the query namespaces that are safe to persist", () => {
    expect(shouldDehydrateQuery({ queryKey: ["controlPlane", "base", "projects"] })).toBe(true)
    expect(shouldDehydrateQuery({ queryKey: ["controlPlane", "base", "providers"] })).toBe(true)
    expect(shouldDehydrateQuery({ queryKey: ["controlPlane", "base", "providerAuth"] })).toBe(false)
    expect(shouldDehydrateQuery({ queryKey: ["controlPlane", "base", "projects"], state: { status: "pending" } })).toBe(false)
    expect(shouldDehydrateQuery({ queryKey: ["controlPlane", "base", "projects"], state: { data: undefined } })).toBe(false)
    expect(shouldDehydrateQuery({ queryKey: ["shell", "base", "commands", "/tmp/ws"] })).toBe(true)
    expect(shouldDehydrateQuery({ queryKey: ["shell", "base", "projects"] })).toBe(false)
    expect(shouldDehydrateQuery({ queryKey: ["directory", "base", "project", "/tmp/ws"] })).toBe(true)
    expect(shouldDehydrateQuery({ queryKey: ["directory", "local", "sessionCache", "/tmp/ws"] })).toBe(false)
    expect(shouldDehydrateQuery({ queryKey: ["session", "default", "row", "/tmp/ws", "sess_1"] })).toBe(true)
    expect(shouldDehydrateQuery({ queryKey: ["session", "default", "messages", "/tmp/ws", "sess_1", "head"] })).toBe(true)
    expect(shouldDehydrateQuery({ queryKey: ["session", "default", "messages", "/tmp/ws", "sess_1", "cursor_1"] })).toBe(false)
    expect(shouldDehydrateQuery({ queryKey: ["session", "messages", "sess_1", "head"] })).toBe(false)
    expect(shouldDehydrateQuery({ queryKey: ["runtime", "base", "workspace", "", "/tmp/ws", "read"] })).toBe(true)
    expect(shouldDehydrateQuery({ queryKey: ["runtime", "base", "mcp", "/tmp/ws"] })).toBe(false)
    // Conversation snapshots are NOT persisted to the shared localStorage blob —
    // durability is owned by the IndexedDB persistence adapter (per-session keys,
    // larger quota) wired into the ChatClient instead.
    expect(shouldDehydrateQuery({ queryKey: ["shell", "session", "sess_1", "conversation"] })).toBe(false)
  })

  test("round-trips persisted filtered queries through storage", async () => {
    const target = storage()
    await installQueryPersister({ storage: target, buster: "build-a", throttleTime: 0 })?.restore

    queryClient.setQueryData(["controlPlane", "base", "projects"], [{ id: "project_1" }])
    queryClient.setQueryData(["runtime", "base", "mcp", "/tmp/ws"], { ignored: true })
    await tick()

    expect(target.getItem(queryPersisterKey)).toContain("project_1")
    expect(target.getItem(queryPersisterKey)).not.toContain("ignored")

    resetQueryPersisterForTest()
    queryClient.clear()

    await installQueryPersister({ storage: target, buster: "build-a", throttleTime: 0 })?.restore

    expect(queryClient.getQueryData(["controlPlane", "base", "projects"])).toEqual([{ id: "project_1" }])
    expect(queryClient.getQueryData(["runtime", "base", "mcp", "/tmp/ws"])).toBeUndefined()
  })

  test("drops stale pending queries before restore", async () => {
    const target = storage()
    target.setItem(queryPersisterKey, JSON.stringify({
      buster: "build-a",
      timestamp: Date.now(),
      clientState: {
        mutations: [],
        queries: [
          {
            queryHash: "[\"controlPlane\",\"base\",\"projects\"]",
            queryKey: ["controlPlane", "base", "projects"],
            state: {
              data: [{ id: "project_1" }],
              dataUpdatedAt: Date.now(),
              error: null,
              errorUpdatedAt: 0,
              failureCount: 0,
              failureReason: null,
              fetchFailureCount: 0,
              fetchFailureReason: null,
              fetchMeta: null,
              fetchStatus: "idle",
              isInvalidated: false,
              status: "success",
            },
          },
          {
            queryHash: "[\"session\",\"default\",\"messages\",\"/tmp/ws\",\"sess_1\",\"head\"]",
            queryKey: ["session", "default", "messages", "/tmp/ws", "sess_1", "head"],
            promise: {},
            state: {
              dataUpdatedAt: 0,
              error: null,
              errorUpdatedAt: 0,
              failureCount: 0,
              failureReason: null,
              fetchFailureCount: 0,
              fetchFailureReason: null,
              fetchMeta: null,
              fetchStatus: "fetching",
              isInvalidated: false,
              status: "pending",
            },
          },
        ],
      },
    }))

    await installQueryPersister({ storage: target, buster: "build-a", throttleTime: 0 })?.restore

    expect(queryClient.getQueryData(["controlPlane", "base", "projects"])).toEqual([{ id: "project_1" }])
    expect(queryClient.getQueryData(["session", "default", "messages", "/tmp/ws", "sess_1", "head"])).toBeUndefined()
  })

  test("drops legacy session keys before restore", async () => {
    const target = storage()
    target.setItem(queryPersisterKey, JSON.stringify({
      buster: "build-a",
      timestamp: Date.now(),
      clientState: {
        mutations: [],
        queries: [
          {
            queryHash: "[\"session\",\"messages\",\"sess_1\",\"head\"]",
            queryKey: ["session", "messages", "sess_1", "head"],
            state: {
              data: { maxEventOrdinal: 1 },
              dataUpdatedAt: Date.now(),
              error: null,
              errorUpdatedAt: 0,
              failureCount: 0,
              failureReason: null,
              fetchFailureCount: 0,
              fetchFailureReason: null,
              fetchMeta: null,
              fetchStatus: "idle",
              isInvalidated: false,
              status: "success",
            },
          },
        ],
      },
    }))

    await installQueryPersister({ storage: target, buster: "build-a", throttleTime: 0 })?.restore

    expect(queryClient.getQueryData(["session", "messages", "sess_1", "head"])).toBeUndefined()
  })

  test("buster changes drop the stored cache", async () => {
    const target = storage()
    await installQueryPersister({ storage: target, buster: "build-a", throttleTime: 0 })?.restore
    queryClient.setQueryData(["controlPlane", "base", "projects"], [{ id: "project_1" }])
    await tick()

    resetQueryPersisterForTest()
    queryClient.clear()

    await installQueryPersister({ storage: target, buster: "build-b", throttleTime: 0 })?.restore

    expect(queryClient.getQueryData(["controlPlane", "base", "projects"])).toBeUndefined()
    expect(target.getItem(queryPersisterKey)).toBeNull()
  })

  test("missing localStorage does not throw", () => {
    expect(installQueryPersister({ storage: null })).toBeUndefined()
  })
})
