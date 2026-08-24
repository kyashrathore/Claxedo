import { render } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"

import { resetWorkspaceVcsCacheHonestyForTest, WorkspaceVcsCacheHonesty } from "./workspace-vcs-cache-honesty"
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

const emit = (details: { type: string; properties?: unknown }) => {
  for (const handler of [...listeners]) handler({ details })
}

afterEach(() => {
  resetWorkspaceVcsCacheHonestyForTest()
  listeners.length = 0
  queryClient.clear()
  vi.restoreAllMocks()
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

    emit({ type: "file.watcher.updated", properties: { file: "src/app.ts" } })

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

  test("a git index write invalidates -- `git add` produces nothing else", async () => {
    vi.useFakeTimers()
    const diffKey = reviewVcsDiffQueryKey({ directory: "/repo", mode: "uncommitted" })
    const statusKey = queryKeys.directory.fileStatus("http://test.local", "/repo", "ws_a")
    queryClient.setQueryData(diffKey, [])
    queryClient.setQueryData(statusKey, [])
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")

    render(() => <WorkspaceVcsCacheHonesty directory="/repo" />)
    // A real `git add` churns the lock around the index write; the lock is
    // dropped and the debounce absorbs the burst into ONE refresh.
    emit({ type: "file.watcher.updated", properties: { file: ".git/index.lock" } })
    emit({ type: "file.watcher.updated", properties: { file: ".git/index" } })
    emit({ type: "file.watcher.updated", properties: { file: ".git/index.lock" } })

    expect(queryClient.getQueryData(diffKey)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(300)
    expect(queryClient.getQueryState(statusKey)?.isInvalidated).toBe(true)
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  test("leaves both caches alone for unrelated events and noisy git internals", async () => {
    vi.useFakeTimers()
    const diffKey = reviewVcsDiffQueryKey({ directory: "/repo", mode: "uncommitted" })
    const statusKey = queryKeys.directory.fileStatus("http://test.local", "/repo", "ws_a")
    queryClient.setQueryData(diffKey, [])
    queryClient.setQueryData(statusKey, [])

    render(() => <WorkspaceVcsCacheHonesty directory="/repo" />)
    emit({ type: "message.updated" })
    emit({ type: "file.watcher.updated", properties: { file: ".git/objects/ab/cdef0123" } })
    emit({ type: "file.watcher.updated", properties: { file: ".git/index.lock" } })
    await vi.advanceTimersByTimeAsync(300)

    expect(queryClient.getQueryData(diffKey)).toEqual([])
    expect(queryClient.getQueryState(statusKey)?.isInvalidated).toBe(false)
  })

  test("two panes share one owner: one refresh per event, last unmount releases", async () => {
    vi.useFakeTimers()
    const statusKey = queryKeys.directory.fileStatus("http://test.local", "/repo", "ws_a")
    queryClient.setQueryData(statusKey, [])
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const remove = vi.spyOn(queryClient, "removeQueries")

    const first = render(() => <WorkspaceVcsCacheHonesty directory="/repo" />)
    const second = render(() => <WorkspaceVcsCacheHonesty directory="/repo" />)
    // The second mount only increments the ref count -- no second listener.
    expect(listeners).toHaveLength(1)

    emit({ type: "file.watcher.updated", properties: { file: "src/app.ts" } })
    await vi.advanceTimersByTimeAsync(300)
    expect(remove).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: statusKey })

    // Disposing one pane keeps the owner alive for the other.
    first.unmount()
    expect(listeners).toHaveLength(1)
    emit({ type: "file.watcher.updated", properties: { file: "src/app.ts" } })
    await vi.advanceTimersByTimeAsync(300)
    expect(invalidate).toHaveBeenCalledTimes(2)

    // Disposing the last pane releases the owner.
    second.unmount()
    expect(listeners).toHaveLength(0)
  })

  test("reconciles the caches once when ownership resumes after an ownerless gap", async () => {
    const diffKey = reviewVcsDiffQueryKey({ directory: "/repo", mode: "uncommitted" })
    const statusKey = queryKeys.directory.fileStatus("http://test.local", "/repo", "ws_a")
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")

    // The first acquisition ever seen for the key is not a gap: no reconcile.
    const before = render(() => <WorkspaceVcsCacheHonesty directory="/repo" />)
    expect(invalidate).not.toHaveBeenCalled()
    before.unmount()

    // Ownerless gap: a change lands with nobody listening; the infinite-stale
    // caches still hold pre-gap data when the next surface mounts.
    queryClient.setQueryData(diffKey, [])
    queryClient.setQueryData(statusKey, [])

    const first = render(() => <WorkspaceVcsCacheHonesty directory="/repo" />)
    expect(queryClient.getQueryData(diffKey)).toBeUndefined()
    expect(queryClient.getQueryState(statusKey)?.isInvalidated).toBe(true)
    expect(invalidate).toHaveBeenCalledTimes(1)

    // One reconciliation per gap, not per mount.
    const second = render(() => <WorkspaceVcsCacheHonesty directory="/repo" />)
    expect(invalidate).toHaveBeenCalledTimes(1)
    first.unmount()
    second.unmount()

    // A new gap reconciles again on the next resume.
    render(() => <WorkspaceVcsCacheHonesty directory="/repo" />)
    expect(invalidate).toHaveBeenCalledTimes(2)
  })
})
