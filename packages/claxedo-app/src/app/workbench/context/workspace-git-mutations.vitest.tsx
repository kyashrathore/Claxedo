import { createRoot } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"

import { useWorkspaceGitMutations } from "./workspace-git-mutations"
import { resetWorkspaceVcsCacheHonestyForTest } from "./workspace-vcs-cache-honesty"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { workspaceGitLogKey, workspaceGitStatusKey } from "@/platform/files/workspace-git-status-query"
import { workspaceDiffSummaryKey } from "@/platform/files/workspace-diff-summary-query"
import { reviewVcsDiffQueryKey } from "@/features/review/ui/review-vcs-cache"
import { isWorkspaceGitError, WorkspaceGitError, type WorkspaceGitClient } from "@/platform/runtime/workspace-git-client"

const git: WorkspaceGitClient = {
  status: vi.fn(async () => ({ branch: "main", ahead: 0, behind: 0, staged: [], unstaged: [] })),
  stage: vi.fn(async () => {}),
  unstage: vi.fn(async () => {}),
  commitStaged: vi.fn(async () => ({ commit: "abc123" })),
  push: vi.fn(async () => ({ remote: "origin", branch: "main" })),
  log: vi.fn(async () => ({ commits: [] })),
}

vi.mock("@/app/providers/sdk/sdk", () => ({
  useSDK: () => ({
    url: "http://test.local",
    directory: "/repo",
    workspaceId: "ws_a",
    git,
  }),
}))

const scope = { baseUrl: "http://test.local", directoryPath: "/repo", workspaceKey: "ws_a" }
const statusKey = workspaceGitStatusKey(scope)
const logKey = [...workspaceGitLogKey(scope), 50]
const fileStatusKey = queryKeys.directory.fileStatus("http://test.local", "/repo", "ws_a")
const branchKey = queryKeys.runtime.vcs("http://test.local", "/repo", "ws_a")
const diffKey = reviewVcsDiffQueryKey({ directory: "/repo", mode: "staged" })
const diffSummaryKey = [...workspaceDiffSummaryKey(scope), "to-from", "origin/main", "HEAD"]

function seedCaches() {
  queryClient.setQueryData(statusKey, { branch: "main", ahead: 0, behind: 0, staged: [], unstaged: [] })
  queryClient.setQueryData(logKey, [])
  queryClient.setQueryData(fileStatusKey, [])
  queryClient.setQueryData(branchKey, { branch: "main" })
  queryClient.setQueryData(diffKey, [])
  queryClient.setQueryData(diffSummaryKey, [])
}

function invalidated(key: readonly unknown[]) {
  return queryClient.getQueryState(key)?.isInvalidated === true
}

function mutations() {
  return createRoot((dispose) => ({ dispose, api: useWorkspaceGitMutations() }))
}

afterEach(() => {
  resetWorkspaceVcsCacheHonestyForTest()
  queryClient.clear()
  vi.clearAllMocks()
})

describe("useWorkspaceGitMutations", () => {
  test("stage writes through the scope's git client, then every VCS cache for the worktree is stale", async () => {
    seedCaches()
    const { api, dispose } = mutations()

    await api.stage(["src/app.ts"])

    expect(git.stage).toHaveBeenCalledWith(["src/app.ts"])
    expect(invalidated(statusKey)).toBe(true)
    expect(invalidated(logKey)).toBe(true)
    expect(invalidated(fileStatusKey)).toBe(true)
    expect(invalidated(branchKey)).toBe(true)
    expect(invalidated(diffSummaryKey)).toBe(true)
    expect(invalidated(diffKey)).toBe(true)
    dispose()
  })

  test("pending names the write in flight and clears once its caches are refreshed", async () => {
    seedCaches()
    let release!: () => void
    vi.mocked(git.commitStaged).mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ commit: "def456" })
    }))
    const { api, dispose } = mutations()

    expect(api.pending()).toBeUndefined()
    const commit = api.commitStaged({ message: "feat: x", amend: true })
    expect(api.pending()).toBe("commit")
    expect(invalidated(statusKey)).toBe(false)

    release()
    expect(await commit).toEqual({ commit: "def456" })
    expect(git.commitStaged).toHaveBeenCalledWith({ message: "feat: x", amend: true })
    expect(api.pending()).toBeUndefined()
    expect(invalidated(statusKey)).toBe(true)
    dispose()
  })

  test("unstage and push refresh the same caches and pass their inputs through", async () => {
    seedCaches()
    const { api, dispose } = mutations()

    await api.unstage(["a.ts", "b.ts"])
    expect(git.unstage).toHaveBeenCalledWith(["a.ts", "b.ts"])
    expect(invalidated(statusKey)).toBe(true)

    seedCaches()
    expect(await api.push({ setUpstream: true })).toEqual({ remote: "origin", branch: "main" })
    expect(git.push).toHaveBeenCalledWith({ setUpstream: true })
    expect(invalidated(logKey)).toBe(true)
    expect(invalidated(branchKey)).toBe(true)
    dispose()
  })

  test("a rejected push rethrows with its code, leaves the caches alone, and clears pending", async () => {
    seedCaches()
    vi.mocked(git.push).mockRejectedValueOnce(new WorkspaceGitError("git_push_rejected", 502, "! [rejected]"))
    const { api, dispose } = mutations()

    const error = await api.push({}).catch((error: unknown) => error)
    expect(isWorkspaceGitError(error) && [error.code, error.message]).toEqual(["git_push_rejected", "! [rejected]"])
    expect(api.pending()).toBeUndefined()
    expect(invalidated(statusKey)).toBe(false)
    expect(invalidated(fileStatusKey)).toBe(false)
    dispose()
  })
})
