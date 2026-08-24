import { render } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"

import { WorkspaceVcsCacheHonesty } from "./workspace-vcs-cache-honesty"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { reviewVcsDiffQueryKey } from "@/features/review/ui/review-vcs-cache"

type Handler = (event: { details: { type: string; properties?: unknown } }) => void

const listeners: Handler[] = []

vi.mock("@/app/providers/sdk/sdk", () => ({
  useSDK: () => ({
    url: "http://test.local",
    workspaceId: "ws_a",
    event: {
      listen: (handler: Handler) => {
        listeners.push(handler)
        return () => {
          const index = listeners.indexOf(handler)
          if (index >= 0) listeners.splice(index, 1)
        }
      },
    },
  }),
}))

afterEach(() => {
  listeners.length = 0
  queryClient.clear()
  vi.useRealTimers()
})

describe("WorkspaceVcsCacheHonesty", () => {
  test("drops review entries and invalidates file status when the worktree changes", async () => {
    vi.useFakeTimers()
    const diffKey = reviewVcsDiffQueryKey({ directory: "/repo", mode: "uncommitted" })
    const statusKey = queryKeys.directory.fileStatus("http://test.local", "/repo", "ws_a")
    queryClient.setQueryData(diffKey, [])
    queryClient.setQueryData(statusKey, [])

    const view = render(() => <WorkspaceVcsCacheHonesty directory="/repo" />)
    expect(listeners).toHaveLength(1)

    listeners[0]!({ details: { type: "file.watcher.updated", properties: { file: "src/app.ts" } } })

    // Review entries are one-shot fetchQuery reads: removed outright, so a
    // review remounting later refetches instead of restoring stale diffs.
    expect(queryClient.getQueryData(diffKey)).toBeUndefined()
    // The file-status entry has a live-observer contract: invalidated (stale),
    // not removed -- after the burst debounce.
    expect(queryClient.getQueryState(statusKey)?.isInvalidated).toBe(false)
    await vi.advanceTimersByTimeAsync(300)
    expect(queryClient.getQueryState(statusKey)?.isInvalidated).toBe(true)

    view.unmount()
    expect(listeners).toHaveLength(0)
  })

  test("leaves both caches alone for unrelated events and git bookkeeping", async () => {
    vi.useFakeTimers()
    const diffKey = reviewVcsDiffQueryKey({ directory: "/repo", mode: "uncommitted" })
    const statusKey = queryKeys.directory.fileStatus("http://test.local", "/repo", "ws_a")
    queryClient.setQueryData(diffKey, [])
    queryClient.setQueryData(statusKey, [])

    render(() => <WorkspaceVcsCacheHonesty directory="/repo" />)
    listeners[0]!({ details: { type: "message.updated" } })
    listeners[0]!({ details: { type: "file.watcher.updated", properties: { file: ".git/index" } } })
    await vi.advanceTimersByTimeAsync(300)

    expect(queryClient.getQueryData(diffKey)).toEqual([])
    expect(queryClient.getQueryState(statusKey)?.isInvalidated).toBe(false)
  })
})
