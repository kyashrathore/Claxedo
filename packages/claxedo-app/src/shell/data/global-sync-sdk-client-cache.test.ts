import { afterEach, describe, expect, test } from "bun:test"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { queryClient } from "../../shared/query/query-client"
import {
  cachedGlobalSyncSdkClient,
  clearGlobalSyncSdkClientsForDirectory,
  clearGlobalSyncSdkClientsForOwner,
  globalSyncSdkClientQueryKey,
  resetGlobalSyncSdkClientCacheForTest,
} from "./global-sync-sdk-client-cache"

afterEach(() => {
  resetGlobalSyncSdkClientCacheForTest()
})

function client(id: string) {
  // as-any: test double implements only the API surface exercised by this test.
  return { id } as unknown as OpencodeClient
}

describe("global sync SDK client cache", () => {
  test("uses an owner-scoped shell query key", () => {
    expect(globalSyncSdkClientQueryKey({
      owner: "sync-a",
      serverUrl: "https://control.example/",
      directory: "/repo/main",
      workspaceId: "ws_1",
    })).toEqual([
      "shell",
      "global-sync-sdk-client",
      "sync-a",
      "https://control.example",
      "/repo/main",
      "ws_1",
    ])
  })

  test("dedupes SDK clients through Query", () => {
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

    expect(cachedGlobalSyncSdkClient(input)).toBe(cachedGlobalSyncSdkClient(input))
    expect(created).toBe(1)
  })

  test("keeps owners and workspaces isolated", () => {
    const base = {
      serverUrl: "https://control.example/",
      directory: "/repo/main",
      create: () => client("client"),
    }

    expect(cachedGlobalSyncSdkClient({ ...base, owner: "sync-a", workspaceId: "ws_1" })).not.toBe(
      cachedGlobalSyncSdkClient({ ...base, owner: "sync-b", workspaceId: "ws_1" }),
    )
    expect(cachedGlobalSyncSdkClient({ ...base, owner: "sync-a", workspaceId: "ws_1" })).not.toBe(
      cachedGlobalSyncSdkClient({ ...base, owner: "sync-a", workspaceId: "ws_2" }),
    )
  })

  test("clears entries by directory or workspace id for disposal", () => {
    const repo = cachedGlobalSyncSdkClient({
      owner: "sync-a",
      directory: "/repo/main",
      workspaceId: "ws_1",
      create: () => client("repo"),
    })
    const plain = cachedGlobalSyncSdkClient({
      owner: "sync-a",
      directory: "/repo/plain",
      create: () => client("plain"),
    })
    const otherOwner = cachedGlobalSyncSdkClient({
      owner: "sync-b",
      directory: "/repo/main",
      workspaceId: "ws_1",
      create: () => client("other"),
    })

    clearGlobalSyncSdkClientsForDirectory({ owner: "sync-a", directory: "ws_1" })
    expect(queryClient.getQueryData(globalSyncSdkClientQueryKey({
      owner: "sync-a",
      directory: "/repo/main",
      workspaceId: "ws_1",
    }))).toBeUndefined()
    expect(cachedGlobalSyncSdkClient({
      owner: "sync-a",
      directory: "/repo/plain",
      create: () => client("plain-next"),
    })).toBe(plain)
    expect(cachedGlobalSyncSdkClient({
      owner: "sync-b",
      directory: "/repo/main",
      workspaceId: "ws_1",
      create: () => client("other-next"),
    })).toBe(otherOwner)

    clearGlobalSyncSdkClientsForDirectory({ owner: "sync-a", directory: "/repo/plain" })
    expect(cachedGlobalSyncSdkClient({
      owner: "sync-a",
      directory: "/repo/plain",
      create: () => client("plain-next"),
    })).not.toBe(plain)
    expect(repo).toBe(repo)
  })

  test("clears all entries for one provider owner", () => {
    const first = cachedGlobalSyncSdkClient({
      owner: "sync-a",
      directory: "/repo/main",
      create: () => client("first"),
    })
    const second = cachedGlobalSyncSdkClient({
      owner: "sync-b",
      directory: "/repo/main",
      create: () => client("second"),
    })

    clearGlobalSyncSdkClientsForOwner("sync-a")

    expect(cachedGlobalSyncSdkClient({
      owner: "sync-a",
      directory: "/repo/main",
      create: () => client("first-next"),
    })).not.toBe(first)
    expect(cachedGlobalSyncSdkClient({
      owner: "sync-b",
      directory: "/repo/main",
      create: () => client("second-next"),
    })).toBe(second)
  })
})
