import { afterEach, describe, expect, test } from "bun:test"
import type { FileContent } from "@opencode-ai/sdk/v2"
import { queryClient } from "@/platform/query/query-client"
import {
  cachedFileReadRequest,
  clearFileRequestCache,
  invalidateCachedFileReadRequest,
  type FileRequestRuntime,
} from "./file-request-cache"
import { invalidateFromWatcher } from "./watcher"

const runtime: FileRequestRuntime = {
  baseUrl: "http://127.0.0.1:4096/",
  directory: "/workspace",
}

afterEach(() => {
  clearFileRequestCache()
  queryClient.clear()
})

describe("file watcher request-cache invalidation", () => {
  test("invalidates prefetched data for a file with no mounted provider state", async () => {
    let reads = 0
    const read = async (): Promise<FileContent> => {
      reads += 1
      return { type: "text", content: `revision-${reads}` }
    }

    await cachedFileReadRequest({ runtime, file: "src/hovered.ts", read })
    invalidateFromWatcher(
      { type: "file.watcher.updated", properties: { file: "src/hovered.ts", event: "change" } },
      {
        normalize: (path) => path,
        hasFile: () => false,
        isOpen: () => false,
        invalidateFile: (file) => invalidateCachedFileReadRequest(runtime, file),
        loadFile: () => {
          throw new Error("an unopened prefetched file must not eagerly mount or load")
        },
        node: () => undefined,
        isDirLoaded: () => false,
        refreshDir: () => {},
      },
    )
    await cachedFileReadRequest({ runtime, file: "src/hovered.ts", read })

    expect(reads).toBe(2)
  })
})
