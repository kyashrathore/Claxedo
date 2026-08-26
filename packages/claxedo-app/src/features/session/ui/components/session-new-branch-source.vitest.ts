import { createRoot, createSignal } from "solid-js"
import { describe, expect, test, vi } from "vitest"
import {
  createNewSessionBranchSource,
  createNewSessionBranchSelection,
  settleNewSessionBranchState,
  shouldQueueNewSessionBranchRefsRefresh,
  type NewSessionBranchState,
} from "./session-new-branch-source"

const dependencies = vi.hoisted(() => ({
  refsRequired: vi.fn(),
  useQuery: vi.fn(),
}))

vi.mock("@tanstack/solid-query", () => ({ useQuery: dependencies.useQuery }))
vi.mock("@/features/session/app-ports", () => ({
  useSDK: () => ({ workspace: () => undefined, url: "http://runtime", createClient: () => ({}) }),
}))
vi.mock("@/platform/api/api", () => ({ getClaxedoServerUrl: () => "http://server" }))
vi.mock("@/platform/runtime/platform-provider", () => ({ usePlatform: () => ({ fetch }) }))
vi.mock("@/platform/runtime/workspace-diff-client", () => ({
  createWorkspaceDiffClient: () => ({ refsRequired: dependencies.refsRequired }),
}))
vi.mock("@/platform/runtime/workspace-runtime-record", () => ({ resolveWorkspaceRuntime: vi.fn() }))
vi.mock("@/platform/runtime/workspace-query", () => ({ workspaceVcsQuery: () => ({}) }))

const choices = [
  { gitRef: "main", sourceBranch: "main" },
  { gitRef: "origin/feature/e2e", sourceBranch: "feature/e2e" },
]

describe("new-session branch snapshot", () => {
  test("replays a VCS invalidation that settles while the first refs request is still loading", async () => {
    let resolveInitial!: (value: { branches: string[]; branchChoices: typeof choices; tags: []; recent: [] }) => void
    const initialRefs = new Promise<{ branches: string[]; branchChoices: typeof choices; tags: []; recent: [] }>((resolve) => {
      resolveInitial = resolve
    })
    dependencies.refsRequired
      .mockReset()
      .mockReturnValueOnce(initialRefs)
      .mockResolvedValue({ branches: choices.map((choice) => choice.gitRef), branchChoices: choices, tags: [], recent: [] })

    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      const [fetching, setFetching] = createSignal(true)
      const [vcs, setVcs] = createSignal({ branch: "main" })
      dependencies.useQuery.mockReturnValue({
        get isFetching() { return fetching() },
        get data() { return vcs() },
        error: undefined,
      })
      const source = createNewSessionBranchSource({
        enabled: () => true,
        directory: () => "/repo",
        worktree: () => "main",
        touch: () => {},
        setWorktree: () => {},
      })

      const deadline = Date.now() + 2_000
      const check = () => {
        if (dependencies.refsRequired.mock.calls.length < 2 || source.state().status === "loading") {
          if (Date.now() > deadline) {
            dispose()
            reject(new Error("branch refs invalidation did not settle"))
            return
          }
          setTimeout(check, 0)
          return
        }
        try {
          expect(dependencies.refsRequired).toHaveBeenCalledTimes(2)
          expect(source.state()).toMatchObject({ status: "ready", current: choices[1] })
          dispose()
          resolve()
        } catch (error) {
          dispose()
          reject(error)
        }
      }
      setTimeout(() => {
        setVcs({ branch: "feature/e2e" })
        setFetching(false)
        resolveInitial({
          branches: ["main"],
          branchChoices: [choices[0]],
          tags: [],
          recent: [],
        })
        check()
      }, 0)
    }))
  })

  test("matches a cloud branch name to its local Git-resolvable remote ref", () => {
    expect(settleNewSessionBranchState({
      scope: "/repo",
      refs: { branches: choices.map((choice) => choice.gitRef), branchChoices: choices, tags: [], recent: [] },
      vcs: { default_branch: "feature/e2e" },
    })).toEqual({
      status: "ready",
      scope: "/repo",
      current: choices[1],
      choices,
    })
  })

  test("reports an error instead of inventing HEAD or treating missing structured refs as empty success", () => {
    expect(settleNewSessionBranchState({
      scope: "/repo",
      refs: { branches: ["main"], tags: [], recent: [] },
      vcs: { branch: "main" },
    })).toEqual({ status: "error", scope: "/repo", message: "Current branch is not resolvable" })
    expect(settleNewSessionBranchState({
      scope: "/repo",
      refs: { branches: [], branchChoices: [], tags: [], recent: [] },
      vcs: {},
    })).toEqual({ status: "error", scope: "/repo", message: "Current branch is unavailable" })
  })

  test("queues a refs refresh after each subscribed VCS reconciliation", () => {
    expect(shouldQueueNewSessionBranchRefsRefresh({
      fetching: false,
      previouslyFetching: true,
    })).toBe(true)
    expect(shouldQueueNewSessionBranchRefsRefresh({
      fetching: true,
      previouslyFetching: false,
    })).toBe(false)
    expect(shouldQueueNewSessionBranchRefsRefresh({
      fetching: false,
      previouslyFetching: undefined,
    })).toBe(false)
  })
})

describe("new-session branch/workspace interaction", () => {
  test("clears an explicit branch for existing workspaces but preserves it for deliberate create", () => {
    createRoot((dispose) => {
      const [state, setState] = createSignal<NewSessionBranchState>({
        status: "ready",
        scope: "/repo",
        current: choices[0],
        choices,
      })
      const [worktree, setWorktreeValue] = createSignal("main")
      const setWorktree = vi.fn()
      const touch = vi.fn()
      const selection = createNewSessionBranchSelection({ state, worktree, setWorktree, touch })

      selection.select("origin/feature/e2e")
      expect(selection.selected()).toEqual(choices[1])
      expect(setWorktree).toHaveBeenLastCalledWith("create")

      selection.syncWorktree("create")
      expect(selection.selected()).toEqual(choices[1])

      setWorktreeValue("create")
      selection.select("main")
      expect(setWorktree).toHaveBeenCalledTimes(1)

      selection.syncWorktree("/repo/existing")
      expect(selection.selected()).toEqual(choices[0])

      selection.select("origin/feature/e2e")
      setWorktreeValue("main")
      selection.select("main")
      expect(selection.selected()).toEqual(choices[0])
      expect(setWorktree).toHaveBeenLastCalledWith("main")
      expect(touch).toHaveBeenCalledTimes(4)

      setState({ status: "loading", scope: "/other" })
      expect(selection.selected()).toBeUndefined()
      expect(selection.choices()).toEqual([])
      dispose()
    })
  })
})
