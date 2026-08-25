import { afterEach, describe, expect, test } from "bun:test"
import type { FileContent } from "@opencode-ai/sdk/v2"
import { queryClient } from "@/platform/query/query-client"
import {
  acquireFileRequestCache,
  cachedFileReadRequest,
  cachedFileTreeRequest,
  clearFileRequestCache,
  fileReadRequestQueryKey,
  fileTreeRequestQueryKey,
  invalidateCachedFileReadRequest,
  type FileRequestRuntime,
} from "./file-request-cache"

const localRuntime: FileRequestRuntime = {
  baseUrl: "http://127.0.0.1:4096/",
  directory: "/workspace",
}

afterEach(() => {
  clearFileRequestCache()
  queryClient.clear()
})

describe("file request cache runtime identity", () => {
  test("keys requests by normalized server, workspace, and directory", () => {
    const runtime = {
      baseUrl: "http://127.0.0.1:4096/",
      workspaceId: "ws_1",
      directory: "/workspace",
    }

    expect(fileReadRequestQueryKey(runtime, "src/index.ts")).toEqual([
      "shell",
      "file-request",
      "http://localhost:4096",
      "ws_1",
      "/workspace",
      "read",
      "src/index.ts",
    ])
    expect(fileTreeRequestQueryKey(runtime, "src")).toEqual([
      "shell",
      "file-request",
      "http://localhost:4096",
      "ws_1",
      "/workspace",
      "tree",
      "src",
    ])
  })

  test("a second live provider preserves results warmed by the first", async () => {
    let reads = 0
    const first = acquireFileRequestCache(localRuntime)
    const content = (): Promise<FileContent> => {
      reads += 1
      return Promise.resolve({ type: "text", content: "hello" })
    }

    await cachedFileReadRequest({ runtime: localRuntime, file: "README.md", read: content })
    const second = acquireFileRequestCache(localRuntime)
    await cachedFileReadRequest({ runtime: localRuntime, file: "README.md", read: content })

    expect(reads).toBe(1)
    first.release()
    await cachedFileReadRequest({ runtime: localRuntime, file: "README.md", read: content })
    expect(reads).toBe(1)

    second.release()
    expect(queryClient.getQueryData(fileReadRequestQueryKey(localRuntime, "README.md"))).toBeUndefined()
  })

  test("last release clears only its exact runtime and release is idempotent", async () => {
    const otherRuntime: FileRequestRuntime = {
      baseUrl: "https://control.example.test",
      workspaceId: "ws_remote",
      directory: "/workspace",
    }
    const local = acquireFileRequestCache(localRuntime)
    const remote = acquireFileRequestCache(otherRuntime)

    await cachedFileTreeRequest({
      runtime: localRuntime,
      dir: "",
      list: async () => [{ path: "local.ts", name: "local.ts", absolute: "/workspace/local.ts", type: "file", ignored: false }],
    })
    await cachedFileTreeRequest({
      runtime: otherRuntime,
      dir: "",
      list: async () => [{ path: "remote.ts", name: "remote.ts", absolute: "/workspace/remote.ts", type: "file", ignored: false }],
    })

    local.release()
    local.release()
    expect(queryClient.getQueryData(fileTreeRequestQueryKey(localRuntime, ""))).toBeUndefined()
    expect(queryClient.getQueryData(fileTreeRequestQueryKey(otherRuntime, ""))).toBeDefined()

    remote.release()
  })

  test("invalidates only the exact prefetched file and runtime", async () => {
    const otherRuntime: FileRequestRuntime = {
      baseUrl: "https://control.example.test",
      workspaceId: "ws_remote",
      directory: "/workspace",
    }
    const read = async (): Promise<FileContent> => ({ type: "text", content: "cached" })
    await cachedFileReadRequest({ runtime: localRuntime, file: "target.ts", read })
    await cachedFileReadRequest({ runtime: localRuntime, file: "sibling.ts", read })
    await cachedFileReadRequest({ runtime: otherRuntime, file: "target.ts", read })

    invalidateCachedFileReadRequest(localRuntime, "target.ts")

    expect(queryClient.getQueryData(fileReadRequestQueryKey(localRuntime, "target.ts"))).toBeUndefined()
    expect(queryClient.getQueryData(fileReadRequestQueryKey(localRuntime, "sibling.ts"))).toBeDefined()
    expect(queryClient.getQueryData(fileReadRequestQueryKey(otherRuntime, "target.ts"))).toBeDefined()
  })
})
