import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import {
  installQueryPersister,
  MAX_QUERY_PERSISTENCE_BYTES,
  queryPersistencePolicies,
  queryPersisterKey,
  resetQueryPersisterForTest,
  shouldDehydrateQuery,
  shouldScheduleQueryPersistence,
} from "@/platform/query/persister"

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
      "shell.session-list-cache",
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
    expect(shouldDehydrateQuery({ queryKey: ["shell", "base", "sessionList", { scope: "global" }] })).toBe(true)
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
    expect(shouldScheduleQueryPersistence(["shell", "session", "sess_1", "status"])).toBe(false)
    expect(shouldScheduleQueryPersistence(["shell", "base", "sessionList", { scope: "global" }])).toBe(true)
  })

  test("non-persisted query traffic never arms a durable cache write", async () => {
    const target = storage()
    let writes = 0
    const counted = {
      ...target,
      setItem(key: string, value: string) {
        writes += 1
        return target.setItem(key, value)
      },
    }
    await installQueryPersister({ storage: counted, buster: "build-a", throttleTime: 0 })?.restore

    queryClient.setQueryData(["shell", "session", "sess_1", "status"], { type: "busy" })
    queryClient.setQueryData(["session-environment", "processes", "/tmp/ws"], { configs: [], processes: [] })
    await tick()
    expect(writes).toBe(0)

    queryClient.setQueryData(["shell", "base", "sessionList", { scope: "global" }], [])
    await tick()
    expect(writes).toBe(1)
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

  test("deletes the legacy full-catalog cache without parsing it", async () => {
    const target = storage()
    target.setItem("claxedo-query-v1", "legacy multi-megabyte provider catalog")
    target.setItem("claxedo-query-v2", "legacy synchronous cache")

    await installQueryPersister({ storage: target, buster: "build-a", throttleTime: 0 })?.restore

    expect(target.getItem("claxedo-query-v1")).toBeNull()
    expect(target.getItem("claxedo-query-v2")).toBeNull()
  })

  test("drops the persisted cache when the hard byte budget is exceeded", async () => {
    const target = storage()
    await installQueryPersister({ storage: target, buster: "build-a", throttleTime: 0, maxBytes: 256 })?.restore

    queryClient.setQueryData(["controlPlane", "base", "projects"], [{ id: "p".repeat(2_000) }])
    await tick()

    expect(target.getItem(queryPersisterKey)).toBeNull()
    expect(MAX_QUERY_PERSISTENCE_BYTES).toBe(2 * 1024 * 1024)
  })

  test("serializes asynchronous writes so an older snapshot cannot win a race", async () => {
    const data = new Map<string, string>()
    let releaseFirst = () => {}
    let markFirstStarted = () => {}
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let writes = 0
    const target = {
      getItem: (key) => data.get(key) ?? null,
      setItem: async (key, value) => {
        writes++
        if (writes === 1) {
          markFirstStarted()
          await firstRelease
        }
        data.set(key, value)
      },
      removeItem: (key) => data.delete(key),
    }
    await installQueryPersister({ storage: target, buster: "build-a", throttleTime: 0 })?.restore

    queryClient.setQueryData(["controlPlane", "base", "projects"], [{ id: "older" }])
    await firstStarted
    queryClient.setQueryData(["controlPlane", "base", "projects"], [{ id: "newer" }])
    await tick()
    releaseFirst()
    await tick()
    await tick()

    expect(target.getItem(queryPersisterKey)).toContain("newer")
    expect(target.getItem(queryPersisterKey)).not.toContain("older")
  })

  test("round-trips Map-valued query data (provider catalog) through storage", async () => {
    const target = storage()
    await installQueryPersister({ storage: target, buster: "build-a", throttleTime: 0 })?.restore

    queryClient.setQueryData(["controlPlane", "base", "providers"], {
      all: new Map([["opencode", { id: "opencode", models: { "big-pickle": { id: "big-pickle" } } }]]),
      connected: ["opencode"],
      default: { opencode: "big-pickle" },
    })
    await tick()

    resetQueryPersisterForTest()
    queryClient.clear()

    await installQueryPersister({ storage: target, buster: "build-a", throttleTime: 0 })?.restore

    const restored = queryClient.getQueryData<{ all: unknown; connected: string[] }>(["controlPlane", "base", "providers"])
    expect(restored?.all instanceof Map).toBe(true)
    expect((restored?.all as Map<string, { id: string }>).get("opencode")?.id).toBe("opencode")
    expect(restored?.connected).toEqual(["opencode"])
  })

  test("persists only provider names and connected default models after lazy detail loading", async () => {
    const target = storage()
    await installQueryPersister({ storage: target, buster: "build-a", throttleTime: 0 })?.restore

    queryClient.setQueryData(["controlPlane", "base", "providers"], {
      all: new Map([
        ["anthropic", {
          id: "anthropic",
          name: "Anthropic",
          options: { enormous: "do-not-persist" },
          models: {
            sonnet: { id: "sonnet", name: "Sonnet" },
            opus: { id: "opus", name: "Opus", metadata: "do-not-persist" },
          },
        }],
        ["openai", { id: "openai", name: "OpenAI", models: { gpt: { id: "gpt" } } }],
      ]),
      connected: ["anthropic"],
      default: { anthropic: "sonnet", openai: "gpt" },
    })
    await tick()

    const cached = target.getItem(queryPersisterKey) ?? ""
    expect(cached).toContain("sonnet")
    expect(cached).toContain("Anthropic")
    expect(cached).toContain("OpenAI")
    expect(cached).not.toContain("opus")
    expect(cached).not.toContain("do-not-persist")
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
