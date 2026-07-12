import { afterEach, describe, expect, mock, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import type { ProjectMeta } from "../../features/session/data/query/types"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"

mock.module("@/platform/runtime/platform-provider", () => ({
  usePlatform: () => ({ platform: "web" }),
}))

async function manager(input: { resolveScopeKey?: (directory: string) => string | undefined } = {}) {
  const { createDirectoryCacheManager } = await import("./directory-cache-manager")
  return createDirectoryCacheManager({
    isBooting: () => false,
    isLoadingSessions: () => false,
    onDispose: () => {},
    resolveScopeKey: input.resolveScopeKey,
    translate: (key) => key,
  })
}

afterEach(() => {
  queryClient.clear()
  localStorage.clear()
})

describe("createDirectoryCacheManager", () => {
  const session = (id: string) => ({
    id,
    title: id,
    time: { created: 1, updated: 1 },
  }) as Session

  test("leaves projectMeta in the TanStack cache instead of seeding a child store", async () => {
    queryClient.setQueryData(queryKeys.directory.projectMeta("/tmp/ws"), {
      name: "Cached",
      icon: { color: "red" },
    } satisfies ProjectMeta)

    const child = await manager()
    const cache = child.sessionCache("/tmp/ws")

    expect("projectMeta" in cache).toBe(false)
    expect(queryClient.getQueryData(queryKeys.directory.projectMeta("/tmp/ws"))).toEqual({
      name: "Cached",
      icon: { color: "red" },
    })
  })

  test("session cache reads do not trigger bootstrap", async () => {
    const child = await manager()

    expect(child.sessionCache("/tmp/no-bootstrap").session).toEqual([])
  })

  test("stores projectMeta writes in TanStack instead of the legacy workspace cache", async () => {
    const child = await manager()

    child.projectMeta("/tmp/ws", { name: "Local" })
    child.projectMeta("/tmp/ws", { icon: { override: "triangle" } })

    expect(queryClient.getQueryData(queryKeys.directory.projectMeta("/tmp/ws"))).toEqual({
      name: "Local",
      icon: { override: "triangle" },
    })
  })

  test("leaves project icon in the TanStack cache instead of seeding a child store", async () => {
    queryClient.setQueryData(queryKeys.directory.icon("/tmp/ws"), "circle")

    const child = await manager()
    const cache = child.sessionCache("/tmp/ws")

    expect("icon" in cache).toBe(false)
    expect(queryClient.getQueryData(queryKeys.directory.icon("/tmp/ws"))).toBe("circle")
  })

  test("stores project icon writes in TanStack instead of the legacy workspace cache", async () => {
    const child = await manager()

    child.projectIcon("/tmp/ws", "triangle")

    expect(queryClient.getQueryData(queryKeys.directory.icon("/tmp/ws"))).toBe("triangle")
  })

  test("reads session list synchronously from the TanStack cache without live bridge updates", async () => {
    queryClient.setQueryData(queryKeys.directory.sessionCache("/tmp/ws"), {
      at: 1,
      limit: 5,
      total: 2,
      session: [session("ses_1"), session("ses_2")],
    })

    const child = await manager()
    const cache = child.sessionCache("/tmp/ws")

    expect(cache.session.map((item) => item.id)).toEqual(["ses_1", "ses_2"])
    expect(cache.total).toBe(2)

    queryClient.setQueryData(queryKeys.directory.sessionCache("/tmp/ws"), {
      at: 2,
      limit: 5,
      total: 1,
      session: [session("ses_3")],
    })

    expect(cache.session.map((item) => item.id)).toEqual(["ses_1", "ses_2"])
    expect(cache.total).toBe(2)
  })

  test("canonicalizes workspace-backed session cache reads to workspaceId with directory fallback", async () => {
    queryClient.setQueryData(queryKeys.directory.projectMeta("/tmp/cloud"), {
      name: "Legacy cloud cache",
    } satisfies ProjectMeta)
    queryClient.setQueryData(queryKeys.directory.sessionCache("/tmp/cloud"), {
      at: 1,
      limit: 5,
      total: 1,
      session: [session("ses_legacy")],
    })

    const child = await manager({
      resolveScopeKey: (directory) => directory === "/tmp/cloud" ? "ws_cloud" : directory,
    })
    const legacyCache = child.sessionCache("/tmp/cloud")
    const workspaceCache = child.sessionCache("ws_cloud")

    expect(legacyCache.session.map((item) => item.id)).toEqual(["ses_legacy"])
    expect(workspaceCache.session.map((item) => item.id)).toEqual(["ses_legacy"])
    expect(child.directories()).toEqual(["ws_cloud"])
  })

  test("mirrors compatibility cache writes to canonical workspaceId and legacy directory aliases", async () => {
    const child = await manager({
      resolveScopeKey: (directory) => directory === "/tmp/cloud" ? "ws_cloud" : directory,
    })

    child.projectMeta("/tmp/cloud", { name: "Canonical" })
    child.projectIcon("/tmp/cloud", "diamond")

    expect(queryClient.getQueryData(queryKeys.directory.projectMeta("ws_cloud"))).toEqual({ name: "Canonical" })
    expect(queryClient.getQueryData(queryKeys.directory.projectMeta("/tmp/cloud"))).toEqual({ name: "Canonical" })
    expect(queryClient.getQueryData(queryKeys.directory.icon("ws_cloud"))).toBe("diamond")
    expect(queryClient.getQueryData(queryKeys.directory.icon("/tmp/cloud"))).toBe("diamond")
  })

  test("does not live-bridge session cache query updates from aliases discovered after canonical cache read", async () => {
    const child = await manager({
      resolveScopeKey: (directory) => directory === "/tmp/cloud" ? "ws_cloud" : directory,
    })
    const cache = child.sessionCache("ws_cloud")

    child.sessionCache("/tmp/cloud")
    queryClient.setQueryData(queryKeys.directory.icon("/tmp/cloud"), "alias-update")
    queryClient.setQueryData(queryKeys.directory.sessionCache("/tmp/cloud"), {
      at: 2,
      limit: 5,
      total: 1,
      session: [session("ses_alias")],
    })

    expect("icon" in cache).toBe(false)
    expect(cache.session).toEqual([])
    expect(cache.total).toBe(0)
  })
})
