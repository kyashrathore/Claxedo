import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "./query-client"
import { cachedDirectoryChildrenRequest, clearDirectorySearchCache } from "./directory-search-cache"

afterEach(() => clearDirectorySearchCache())

describe("directory children request cache", () => {
  test("shares in-flight and fresh requests only for the same server and directory", async () => {
    let resolve!: (rows: Array<{ name: string; absolute: string }>) => void
    let calls = 0
    const response = new Promise<Array<{ name: string; absolute: string }>>((done) => { resolve = done })
    const input = { serverUrl: "server-a", directory: "/repo", list: () => { calls++; return response } }
    const first = cachedDirectoryChildrenRequest(input)
    const second = cachedDirectoryChildrenRequest(input)
    expect(calls).toBe(1)
    resolve([{ name: "src", absolute: "/repo/src" }])
    expect(await first).toEqual([{ name: "src", absolute: "/repo/src" }])
    expect(await second).toEqual([{ name: "src", absolute: "/repo/src" }])
    expect(await cachedDirectoryChildrenRequest(input)).toEqual([{ name: "src", absolute: "/repo/src" }])
    expect(calls).toBe(1)
    await cachedDirectoryChildrenRequest({ ...input, serverUrl: "server-b" })
    await cachedDirectoryChildrenRequest({ ...input, directory: "/other" })
    expect(calls).toBe(3)
  })

  test("forced reads replace stale rows and server-scoped clear preserves other servers", async () => {
    let callsA = 0
    let callsB = 0
    const first = { serverUrl: "server-a", directory: "/repo", list: async () => [{ name: `a-${++callsA}`, absolute: "/repo/a" }] }
    const second = { serverUrl: "server-b", directory: "/repo", list: async () => [{ name: `b-${++callsB}`, absolute: "/repo/b" }] }
    await cachedDirectoryChildrenRequest(first)
    await cachedDirectoryChildrenRequest(second)
    expect(await cachedDirectoryChildrenRequest({ ...first, force: true })).toEqual([{ name: "a-2", absolute: "/repo/a" }])
    clearDirectorySearchCache("server-a")
    expect(await cachedDirectoryChildrenRequest(first)).toEqual([{ name: "a-3", absolute: "/repo/a" }])
    expect(await cachedDirectoryChildrenRequest(second)).toEqual([{ name: "b-1", absolute: "/repo/b" }])
    expect([callsA, callsB]).toEqual([3, 1])
    expect(queryClient.getQueryCache().findAll({ queryKey: ["shell", "directory-children-request"] })).toHaveLength(2)
  })
})
