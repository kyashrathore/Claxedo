import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { clearFileRequestCache, type FileRequestRuntime } from "./file-request-cache"
import { createFileTreeStore } from "./tree-store"

const runtime: FileRequestRuntime = {
  baseUrl: "http://localhost:4096",
  directory: "/repo",
}

afterEach(() => {
  clearFileRequestCache()
  queryClient.clear()
})

describe("file tree view reset", () => {
  test("clears local tree state without invalidating the runtime request cache", async () => {
    let lists = 0
    const tree = createFileTreeStore({
      runtime: () => runtime,
      normalizeDir: (value) => value,
      list: async () => {
        lists += 1
        return [{ path: "src", name: "src", absolute: "/repo/src", type: "directory", ignored: false }]
      },
      onError: () => {},
    })

    await tree.listDir("")
    expect(tree.children("").map((node) => node.path)).toEqual(["src"])
    expect(lists).toBe(1)

    tree.reset()
    expect(tree.children("")).toEqual([])
    await tree.listDir("")
    expect(tree.children("").map((node) => node.path)).toEqual(["src"])
    expect(lists).toBe(1)
  })
})
