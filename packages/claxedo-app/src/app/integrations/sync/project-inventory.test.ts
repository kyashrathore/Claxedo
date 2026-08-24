import { describe, expect, test } from "bun:test"
import {
  migrateLegacyProjectInventoryToQueryCache,
  projectInventoryQuery,
  projectInventoryQueryKey,
} from "./project-inventory"

describe("project inventory shell-data boundary", () => {
  test("exposes project query options and keys without the global sync surface", () => {
    const query = {
      queryKey: ["projects", "test"] as const,
      queryFn: async () => [],
    }
    const source = {
      projects: () => query,
    }

    expect(projectInventoryQuery({ source })).toBe(query)
    expect(projectInventoryQueryKey({ source })).toEqual(["projects", "test"])
  })

  test("migrates the legacy persisted project cache into the query cache once", () => {
    const memory = new Map<string, string>()
    memory.set(
      "opencode.global.dat:globalSync.project",
      JSON.stringify({ value: [{ id: "p2", icon: { url: "old" } }] }),
    )
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      removeItem: (key: string) => {
        memory.delete(key)
      },
    }
    const cache = new Map<readonly unknown[], unknown>()
    const queryKey = ["projects", "test"] as const

    expect(
      migrateLegacyProjectInventoryToQueryCache({
        cache: {
          read: () => cache.get(queryKey) as Array<{ id: string }> | undefined,
          write: (value) => cache.set(queryKey, value),
        },
        storage,
        sanitize: (project) => ({ ...project, icon: undefined }),
      }),
    ).toEqual([{ id: "p2", icon: { url: "old" } }])
    expect(cache.get(queryKey)).toEqual([{ id: "p2", icon: undefined }])
    expect(storage.getItem("opencode.global.dat:globalSync.project")).toBeNull()
    expect(
      migrateLegacyProjectInventoryToQueryCache({
        cache: {
          read: () => cache.get(queryKey) as Array<{ id: string }> | undefined,
          write: (value) => cache.set(queryKey, value),
        },
        storage,
      }),
    ).toEqual([])
  })

  test("does not resurrect legacy projects when the query cache already has a server value", () => {
    const memory = new Map<string, string>()
    memory.set("opencode.global.dat:globalSync.project", JSON.stringify({ value: [{ id: "deleted" }] }))
    const queryKey = ["projects", "test"] as const
    const cache = new Map<readonly unknown[], unknown>([[queryKey, []]])

    migrateLegacyProjectInventoryToQueryCache({
      cache: {
        read: () => cache.get(queryKey) as Array<{ id: string }> | undefined,
        write: (value) => cache.set(queryKey, value),
      },
      storage: {
        getItem: (key) => memory.get(key) ?? null,
        removeItem: (key) => {
          memory.delete(key)
        },
      },
    })

    expect(cache.get(queryKey)).toEqual([])
    expect(memory.get("opencode.global.dat:globalSync.project")).toBeUndefined()
  })

  test("ignores malformed legacy storage during migration", () => {
    const memory = new Map<string, string>([["opencode.global.dat:globalSync.project", "{"]])
    const queryKey = ["projects", "test"] as const
    const cache = new Map<readonly unknown[], unknown>()

    expect(
      migrateLegacyProjectInventoryToQueryCache({
        cache: {
          read: () => cache.get(queryKey) as Array<{ id: string }> | undefined,
          write: (value) => cache.set(queryKey, value),
        },
        storage: {
          getItem: (key) => memory.get(key) ?? null,
          removeItem: (key) => {
            memory.delete(key)
          },
        },
      }),
    ).toEqual([])
    expect(cache.has(queryKey)).toBe(false)
    expect(memory.get("opencode.global.dat:globalSync.project")).toBeUndefined()
  })
})
