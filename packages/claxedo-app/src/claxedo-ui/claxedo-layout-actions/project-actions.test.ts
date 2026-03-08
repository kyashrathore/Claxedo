import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { base64Encode } from "@opencode-ai/util/encode"

let createProjectActions: typeof import("./project-actions").createProjectActions
let WorktreeState: typeof import("@/utils/worktree").Worktree

const toasts: Array<{ title?: string; description?: string }> = []

beforeAll(async () => {
  mock.module("@opencode-ai/app-shared", () => ({
    getExtensions: () => ({ app: {} }),
  }))

  mock.module("@opencode-ai/claxedo-app", () => ({
    DialogSettings: () => null,
  }))

  mock.module("@opencode-ai/ui/toast", () => ({
    showToast: (input: { title?: string; description?: string }) => {
      toasts.push(input)
      return 0
    },
  }))

  mock.module("@claxedo/utils/worktree", () => ({
    validWorktree: () => true,
  }))

  mock.module("@/components/dialog-select-directory", () => ({
    DialogSelectDirectory: () => null,
  }))

  mock.module("../../components/dialog-create-cloud-project", () => ({
    DialogCreateCloudProject: () => null,
  }))

  mock.module("../../components/dialog-new-project", () => ({
    DialogNewProject: () => null,
  }))

  mock.module("../components/dialogs", () => ({
    DialogDeleteWorkspace: () => null,
  }))

  const mod = await import("./project-actions")
  createProjectActions = mod.createProjectActions
  WorktreeState = (await import("@/utils/worktree")).Worktree
})

beforeEach(() => {
  toasts.length = 0
})

function make(dir: string) {
  const adds: Array<{ directory: string; sessionId: string; title: string }> = []
  const acts: string[] = []
  const navs: Array<{ path: string; reason: string; details?: Record<string, unknown> }> = []
  const child = { status: "loading" as "loading" | "partial" | "complete" }

  const props = {
    flowLog: () => undefined,
    params: {},
    activeWorkspaceId: () => "/workspace/main",
    activeProjectId: () => "p1",
    projects: () => [{ id: "p1", worktree: "/workspace/main", sandboxes: [] }],
    navigate: (_path: string) => undefined,
    dialog: { close: () => undefined },
    globalSDK: {
      client: {
        worktree: {
          create: async () => ({ data: { directory: dir, name: "feature" } }),
        },
      },
    },
    layout: {},
    platform: {},
    config: {},
    globalSync: {
      child: () => [child, () => undefined],
    },
    claxedo: {
      workspaceRecency: {
        recordAccess: () => undefined,
      },
      worktree: {
        setPinned: () => undefined,
        setDefault: () => undefined,
      },
      split: {
        focusedId: () => "g1",
      },
      topTabs: {
        setActive: (id: string) => acts.push(id),
        addSession: (directory: string, sessionId: string, title: string) => {
          adds.push({ directory, sessionId, title })
          return "tab-new"
        },
      },
    },
  } as any

  const nav = (path: string, reason: string, details?: Record<string, unknown>) => {
    navs.push({ path, reason, details })
  }

  return { props, adds, acts, navs, nav, child }
}

describe("createProjectActions.handleNewWorkspace", () => {
  test("waits for worktree readiness before opening the new session tab", async () => {
    const dir = `/workspace/feature-${Date.now().toString(36)}`
    const { props, adds, acts, navs, nav, child } = make(dir)

    const run = createProjectActions(props, nav).handleNewWorkspace({
      id: "p1",
      worktree: "/workspace/main",
      sandboxes: [],
    } as any)

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(adds).toEqual([])
    expect(acts).toEqual([])
    expect(navs).toEqual([])

    child.status = "complete"
    WorktreeState.ready(dir)

    const result = await run

    expect(result).toEqual({
      id: dir,
      directory: dir,
      name: "feature",
      projectWorktree: "/workspace/main",
      canDelete: true,
    })
    expect(adds).toEqual([{ directory: dir, sessionId: "new", title: "New Session" }])
    expect(acts).toEqual(["tab-new"])
    expect(navs).toEqual([
      {
        path: `/${base64Encode(dir)}/tab/tab-new`,
        reason: "new-workspace-created",
        details: {
          projectId: "p1",
          created: dir,
          tabId: "tab-new",
        },
      },
    ])
  })

  test("shows an error and skips tab creation when worktree startup fails", async () => {
    const dir = `/workspace/feature-${Date.now().toString(36)}-fail`
    const { props, adds, acts, navs, nav } = make(dir)

    const run = createProjectActions(props, nav).handleNewWorkspace({
      id: "p1",
      worktree: "/workspace/main",
      sandboxes: [],
    } as any)

    await new Promise((resolve) => setTimeout(resolve, 0))

    WorktreeState.failed(dir, "boom")

    const result = await run

    expect(result).toBeUndefined()
    expect(adds).toEqual([])
    expect(acts).toEqual([])
    expect(navs).toEqual([])
    expect(toasts).toEqual([
      {
        title: "Failed to create worktree",
        description: "boom",
        variant: "error",
      },
    ])
  })
})
