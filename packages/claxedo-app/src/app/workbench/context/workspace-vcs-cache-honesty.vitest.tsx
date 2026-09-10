import { render } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"

import { invalidateWorkspaceVcs, resetWorkspaceVcsCacheHonestyForTest, WorkspaceVcsCacheHonesty } from "./workspace-vcs-cache-honesty"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { workspaceGitLogKey, workspaceGitStatusKey } from "@/platform/files/workspace-git-status-query"
import { workspaceDiffSummaryKey } from "@/platform/files/workspace-diff-summary-query"
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
  // Snapshot: a handler may unsubscribe itself, which splices `listeners`.
  for (const handler of listeners.slice()) handler({ details })
}

const vcsKey = queryKeys.runtime.vcs("http://test.local", "/repo", "ws_a")
const gitScope = { baseUrl: "http://test.local", directoryPath: "/repo", workspaceKey: "ws_a" }
const gitStatusKey = workspaceGitStatusKey(gitScope)
const gitLogKey = [...workspaceGitLogKey(gitScope), 50]
const diffSummaryKey = [...workspaceDiffSummaryKey(gitScope), "to-from", "origin/main", "HEAD"]
/** Invalidations of one key family, so counts stay per-cache and readable. */
const invalidationsOf = (
  spy: { mock: { calls: unknown[][] } },
  key: readonly unknown[],
) =>
  spy.mock.calls.filter((call) => {
    const filters = call[0] as { queryKey?: readonly unknown[] } | undefined
    const target = filters?.queryKey
    return !!target && target.every((part, index) => part === key[index])
  }).length

afterEach(() => {
  resetWorkspaceVcsCacheHonestyForTest()
  listeners.length = 0
  queryClient.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("WorkspaceVcsCacheHonesty", () => {
  test("invalidates review entries and file status when the worktree changes", async () => {
    vi.useFakeTimers()
    const diffKey = reviewVcsDiffQueryKey({ directory: "/repo", mode: "uncommitted" })
    const statusKey = queryKeys.directory.fileStatus("http://test.local", "/repo", "ws_a")
    queryClient.setQueryData(diffKey, [])
    queryClient.setQueryData(statusKey, [])

    const view = render(() => <WorkspaceVcsCacheHonesty directory="/repo" />)
    expect(listeners).toHaveLength(1)

    emit({ type: "file.watcher.updated", properties: { file: "src/app.ts" } })

    // The mounted Review surface observes this entry, so it is invalidated
    // rather than removed: the surface refetches in place, and a surface that
    // mounts later refetches too because a stale entry does not satisfy
    // `fetchQuery`.
    expect(queryClient.getQueryState(diffKey)?.isInvalidated).toBe(true)
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

    expect(queryClient.getQueryState(diffKey)?.isInvalidated).toBe(true)
    await vi.advanceTimersByTimeAsync(300)
    expect(queryClient.getQueryState(statusKey)?.isInvalidated).toBe(true)
    expect(invalidationsOf(invalidate, statusKey)).toBe(1)
    expect(invalidationsOf(invalidate, gitStatusKey)).toBe(1)
    // An index write never moves HEAD, so the branch summary stays fresh.
    expect(invalidationsOf(invalidate, vcsKey)).toBe(0)
    expect(invalidationsOf(invalidate, gitLogKey)).toBe(0)
  })

  test("a HEAD write refetches the branch summary; a worktree write does not", async () => {
    vi.useFakeTimers()
    queryClient.setQueryData(vcsKey, { branch: "main" })
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")

    render(() => <WorkspaceVcsCacheHonesty directory="/repo" />)

    // Saving a file changes the diffs, never the branch.
    emit({ type: "file.watcher.updated", properties: { file: "src/app.ts" } })
    await vi.advanceTimersByTimeAsync(300)
    expect(invalidationsOf(invalidate, vcsKey)).toBe(0)
    expect(queryClient.getQueryState(vcsKey)?.isInvalidated).toBe(false)

    // Checking out a branch writes HEAD. The runtime VCS entry is
    // infinite-stale, so this event is the ONLY thing that can refresh it.
    emit({ type: "file.watcher.updated", properties: { file: ".git/HEAD" } })
    expect(invalidationsOf(invalidate, vcsKey)).toBe(1)
    // Invalidated, not removed: the environment card observes it and refetches
    // in place rather than blanking its branch chip.
    expect(queryClient.getQueryState(vcsKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryData(vcsKey)).toEqual({ branch: "main" })

    // A runtime branch event does the same without any watcher involvement.
    emit({ type: "vcs.branch.updated" })
    expect(invalidationsOf(invalidate, vcsKey)).toBe(2)
  })

  test("one runtime VCS invalidation covers every workspace scope for the directory", async () => {
    const unscoped = queryKeys.runtime.vcs("http://test.local", "/repo")
    queryClient.setQueryData(vcsKey, { branch: "main" })
    queryClient.setQueryData(unscoped, { branch: "main" })

    render(() => <WorkspaceVcsCacheHonesty directory="/repo" />)
    emit({ type: "vcs.branch.updated" })

    // The workbench scope and a signed session pane resolve the same worktree
    // to different workspace ids (and resolve it late). Both are stale.
    expect(queryClient.getQueryState(vcsKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(unscoped)?.isInvalidated).toBe(true)
  })

  test("git status follows worktree and index writes; the commit log follows HEAD", async () => {
    vi.useFakeTimers()
    queryClient.setQueryData(gitStatusKey, { staged: [], unstaged: [] })
    queryClient.setQueryData(gitLogKey, [])
    queryClient.setQueryData(diffSummaryKey, [])

    render(() => <WorkspaceVcsCacheHonesty directory="/repo" />)

    // `git add` in a terminal moves a file between the groups with no
    // worktree event; the index write is the only signal, debounced like
    // file status so the lock churn around it yields one refresh.
    emit({ type: "file.watcher.updated", properties: { file: ".git/index" } })
    expect(queryClient.getQueryState(gitStatusKey)?.isInvalidated).toBe(false)
    await vi.advanceTimersByTimeAsync(300)
    expect(queryClient.getQueryState(gitStatusKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(gitLogKey)?.isInvalidated).toBe(false)
    expect(queryClient.getQueryState(diffSummaryKey)?.isInvalidated).toBe(false)

    // A commit from a terminal writes the branch ref: the graph and every
    // ref-to-ref comparison (origin/main..HEAD) are stale now.
    emit({ type: "file.watcher.updated", properties: { file: ".git/refs/heads/main" } })
    expect(queryClient.getQueryState(gitLogKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(diffSummaryKey)?.isInvalidated).toBe(true)
  })

  test("invalidateWorkspaceVcs refreshes every event-owned cache for the worktree at once", async () => {
    const diffKey = reviewVcsDiffQueryKey({ directory: "/repo", mode: "staged" })
    const statusKey = queryKeys.directory.fileStatus("http://test.local", "/repo", "ws_a")
    queryClient.setQueryData(diffKey, [])
    queryClient.setQueryData(statusKey, [])
    queryClient.setQueryData(vcsKey, { branch: "main" })
    queryClient.setQueryData(gitStatusKey, { staged: [], unstaged: [] })
    queryClient.setQueryData(gitLogKey, [])
    queryClient.setQueryData(diffSummaryKey, [])

    await invalidateWorkspaceVcs({ directory: "/repo", serverUrl: "http://test.local", workspaceId: "ws_a" })

    for (const key of [diffKey, statusKey, vcsKey, gitStatusKey, gitLogKey, diffSummaryKey]) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
    }
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
    const diffKey = reviewVcsDiffQueryKey({ directory: "/repo", mode: "uncommitted" })
    const statusKey = queryKeys.directory.fileStatus("http://test.local", "/repo", "ws_a")
    queryClient.setQueryData(diffKey, [])
    queryClient.setQueryData(statusKey, [])
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")

    const first = render(() => <WorkspaceVcsCacheHonesty directory="/repo" />)
    const second = render(() => <WorkspaceVcsCacheHonesty directory="/repo" />)
    // The second mount only increments the ref count -- no second listener.
    expect(listeners).toHaveLength(1)

    emit({ type: "file.watcher.updated", properties: { file: "src/app.ts" } })
    await vi.advanceTimersByTimeAsync(300)
    expect(queryClient.getQueryState(diffKey)?.isInvalidated).toBe(true)
    expect(invalidationsOf(invalidate, statusKey)).toBe(1)
    expect(invalidationsOf(invalidate, gitStatusKey)).toBe(1)

    // Disposing one pane keeps the owner alive for the other.
    first.unmount()
    expect(listeners).toHaveLength(1)
    emit({ type: "file.watcher.updated", properties: { file: "src/app.ts" } })
    await vi.advanceTimersByTimeAsync(300)
    expect(invalidationsOf(invalidate, statusKey)).toBe(2)

    // Disposing the last pane releases the owner.
    second.unmount()
    expect(listeners).toHaveLength(0)
  })

  test("reconciles the caches once when ownership resumes after an ownerless gap", async () => {
    const diffKey = reviewVcsDiffQueryKey({ directory: "/repo", mode: "uncommitted" })
    const statusKey = queryKeys.directory.fileStatus("http://test.local", "/repo", "ws_a")
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    // Each reconciliation invalidates both event-owned caches once.
    const reconciliations = () => ({
      fileStatus: invalidationsOf(invalidate, statusKey),
      runtimeVcs: invalidationsOf(invalidate, vcsKey),
    })

    // The first acquisition ever seen for the key is not a gap: no reconcile.
    const before = render(() => <WorkspaceVcsCacheHonesty directory="/repo" />)
    expect(invalidate).not.toHaveBeenCalled()
    before.unmount()

    // Ownerless gap: a change lands with nobody listening; the infinite-stale
    // caches still hold pre-gap data when the next surface mounts.
    queryClient.setQueryData(diffKey, [])
    queryClient.setQueryData(statusKey, [])
    queryClient.setQueryData(vcsKey, { branch: "before-the-gap" })
    queryClient.setQueryData(gitStatusKey, { staged: [], unstaged: [] })
    queryClient.setQueryData(gitLogKey, [])

    const first = render(() => <WorkspaceVcsCacheHonesty directory="/repo" />)
    expect(queryClient.getQueryState(diffKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(statusKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(gitStatusKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(gitLogKey)?.isInvalidated).toBe(true)
    // A branch change during the gap is unobservable, so the branch summary
    // has to be reconciled too -- otherwise infinite-stale means forever.
    expect(queryClient.getQueryState(vcsKey)?.isInvalidated).toBe(true)
    expect(reconciliations()).toEqual({ fileStatus: 1, runtimeVcs: 1 })

    // One reconciliation per gap, not per mount.
    const second = render(() => <WorkspaceVcsCacheHonesty directory="/repo" />)
    expect(reconciliations()).toEqual({ fileStatus: 1, runtimeVcs: 1 })
    first.unmount()
    second.unmount()

    // A new gap reconciles again on the next resume.
    render(() => <WorkspaceVcsCacheHonesty directory="/repo" />)
    expect(reconciliations()).toEqual({ fileStatus: 2, runtimeVcs: 2 })
  })
})
