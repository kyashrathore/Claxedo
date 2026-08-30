import { afterEach, describe, expect, test } from "bun:test"
import { createClaxedoServerClient } from "@/platform/api/server-client-contract"
import { queryClient } from "@/platform/query/query-client"
import {
  cachedGlobalSyncServerClient,
  clearGlobalSyncServerClientsForDirectory,
  clearGlobalSyncServerClientsForOwner,
  globalSyncServerClientQueryKey,
  resetGlobalSyncServerClientCacheForTest,
} from "./global-sync-sdk-client-cache"

afterEach(() => {
  resetGlobalSyncServerClientCacheForTest()
})

function client(id: string) {
  return Object.assign(createClaxedoServerClient({
    baseUrl: "https://server.example",
    request: async () => Response.json({}),
  }), {
    id,
  })
}

describe("global sync server client cache", () => {
  test("uses an owner-scoped shell query key", () => {
    expect(globalSyncServerClientQueryKey({
      owner: "sync-a",
      serverUrl: "https://control.example/",
      directory: "/repo/main",
      workspaceId: "ws_1",
    })).toEqual([
      "shell",
      "global-sync-server-client",
      "sync-a",
      "https://control.example",
      "/repo/main",
      "ws_1",
    ])
  })

  test("dedupes server clients through Query", () => {
    let created = 0
    const input = {
      owner: "sync-a",
      serverUrl: "https://control.example/",
      directory: "/repo/main",
      workspaceId: "ws_1",
      create: () => {
        created += 1
        return client(`client-${created}`)
      },
    }

    expect(cachedGlobalSyncServerClient(input)).toBe(cachedGlobalSyncServerClient(input))
    expect(created).toBe(1)
  })

  test("keeps owners and workspaces isolated", () => {
    const base = {
      serverUrl: "https://control.example/",
      directory: "/repo/main",
      create: () => client("client"),
    }

    expect(cachedGlobalSyncServerClient({ ...base, owner: "sync-a", workspaceId: "ws_1" })).not.toBe(
      cachedGlobalSyncServerClient({ ...base, owner: "sync-b", workspaceId: "ws_1" }),
    )
    expect(cachedGlobalSyncServerClient({ ...base, owner: "sync-a", workspaceId: "ws_1" })).not.toBe(
      cachedGlobalSyncServerClient({ ...base, owner: "sync-a", workspaceId: "ws_2" }),
    )
  })

  test("clears entries by directory or workspace id for disposal", () => {
    const repo = cachedGlobalSyncServerClient({
      owner: "sync-a",
      directory: "/repo/main",
      workspaceId: "ws_1",
      create: () => client("repo"),
    })
    const plain = cachedGlobalSyncServerClient({
      owner: "sync-a",
      directory: "/repo/plain",
      create: () => client("plain"),
    })
    const otherOwner = cachedGlobalSyncServerClient({
      owner: "sync-b",
      directory: "/repo/main",
      workspaceId: "ws_1",
      create: () => client("other"),
    })

    clearGlobalSyncServerClientsForDirectory({ owner: "sync-a", directory: "ws_1" })
    expect(queryClient.getQueryData(globalSyncServerClientQueryKey({
      owner: "sync-a",
      directory: "/repo/main",
      workspaceId: "ws_1",
    }))).toBeUndefined()
    expect(cachedGlobalSyncServerClient({
      owner: "sync-a",
      directory: "/repo/plain",
      create: () => client("plain-next"),
    })).toBe(plain)
    expect(cachedGlobalSyncServerClient({
      owner: "sync-b",
      directory: "/repo/main",
      workspaceId: "ws_1",
      create: () => client("other-next"),
    })).toBe(otherOwner)

    clearGlobalSyncServerClientsForDirectory({ owner: "sync-a", directory: "/repo/plain" })
    expect(cachedGlobalSyncServerClient({
      owner: "sync-a",
      directory: "/repo/plain",
      create: () => client("plain-next"),
    })).not.toBe(plain)
    expect(repo).toBe(repo)
  })

  test("clears all entries for one provider owner", () => {
    const first = cachedGlobalSyncServerClient({
      owner: "sync-a",
      directory: "/repo/main",
      create: () => client("first"),
    })
    const second = cachedGlobalSyncServerClient({
      owner: "sync-b",
      directory: "/repo/main",
      create: () => client("second"),
    })

    clearGlobalSyncServerClientsForOwner("sync-a")

    expect(cachedGlobalSyncServerClient({
      owner: "sync-a",
      directory: "/repo/main",
      create: () => client("first-next"),
    })).not.toBe(first)
    expect(cachedGlobalSyncServerClient({
      owner: "sync-b",
      directory: "/repo/main",
      create: () => client("second-next"),
    })).toBe(second)
  })
})
