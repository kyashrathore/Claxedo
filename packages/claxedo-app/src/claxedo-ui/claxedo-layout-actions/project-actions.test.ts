import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { base64Encode } from "@opencode-ai/util/encode"

let createProjectActions: typeof import("./project-actions").createProjectActions
let WorktreeState: typeof import("@/utils/worktree").Worktree
let deleteDialogProps: undefined | { onDelete: (dir: string) => Promise<void> | void }

const toasts: Array<{ title?: string; description?: string }> = []

beforeAll(async () => {
  mock.module("@/components/dialog-settings", () => ({
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

  mock.module("../../components/dialog-create-cloud-workspace", () => ({
    DialogCreateCloudWorkspace: () => null,
  }))

  mock.module("../../components/dialog-new-project", () => ({
    DialogNewProject: () => null,
  }))

  mock.module("../components/dialogs", () => ({
    DialogDeleteWorkspace: (props: { onDelete: (dir: string) => Promise<void> | void }) => {
      deleteDialogProps = props
      return null
    },
    DialogRecoverWorkspace: () => null,
  }))

  const mod = await import("./project-actions")
  createProjectActions = mod.createProjectActions
  WorktreeState = (await import("@/utils/worktree")).Worktree
})

beforeEach(() => {
  toasts.length = 0
  deleteDialogProps = undefined
  ;(globalThis as { React?: { createElement: (component: (props: unknown) => unknown, props: unknown) => unknown } }).React = {
    createElement: (component, props) => component(props),
  }
})

function make(dir: string) {
  const adds: Array<{ directory: string; sessionId: string; title: string }> = []
  const acts: string[] = []
  const navs: Array<{ path: string; reason: string; details?: Record<string, unknown> }> = []
  const routes: string[] = []
  const closes: string[] = []
  const cleaned: Array<{ directory: string; projectId?: string }> = []
  const shows: unknown[] = []
  const child = { status: "loading" as "loading" | "partial" | "complete" }
  const data = {
    project: [{
      id: "p1",
      worktree: "/workspace/main",
      sandboxes: [] as string[],
      workspaces: {} as Record<string, unknown>,
    }],
  }

  const props = {
    flowLog: () => undefined,
    params: {},
    activeWorkspaceId: () => "/workspace/main",
    activeProjectId: () => "p1",
    projects: () => data.project,
    navigate: (path: string) => routes.push(path),
    dialog: {
      close: () => undefined,
      show: (view: () => unknown) => {
        shows.push(view())
      },
    },
    globalSDK: {
      client: {
        worktree: {
          create: async () => ({ data: { directory: dir, name: "feature" } }),
          remove: async () => true,
        },
      },
    },
    layout: {
      projects: {
        close: (directory: string) => closes.push(directory),
      },
    },
    platform: {},
    config: {},
    globalSync: {
      data,
      set: (key: string, index: number, field: string, value: unknown) => {
        if (key !== "project") return
        ;(data.project[index] as Record<string, unknown>)[field] = value
      },
      child: () => [child, () => undefined],
    },
    claxedo: {
      workspaceRecency: {
        recordAccess: () => undefined,
        cleanup: () => undefined,
      },
      cleanupDeletedWorktree: (directory: string, projectId?: string) => {
        cleaned.push({ directory, projectId })
      },
      worktree: {
        pinned: () => null,
        default: () => "/workspace/main",
        setPinned: () => undefined,
        setDefault: () => undefined,
      },
      split: {
        focusedId: () => "g1",
      },
      topTabs: {
        items: () => [],
        close: () => undefined,
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

  return { props, adds, acts, navs, nav, child, routes, closes, cleaned, shows, data }
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
        path: `/${base64Encode(dir)}/session`,
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

  test("closing the active project marks it closed and navigates away", () => {
    const { props, nav, routes, closes, cleaned } = make("/workspace/feature")
    props.activeProjectId = () => "/workspace/main"

    createProjectActions(props, nav).handleRemoveProject({
      id: "p1",
      worktree: "/workspace/main",
      sandboxes: ["/workspace/formlink", "/workspace/feature"],
    } as any)

    expect(cleaned).toEqual([
      { directory: "/workspace/main", projectId: "p1" },
      { directory: "/workspace/formlink", projectId: "p1" },
      { directory: "/workspace/feature", projectId: "p1" },
    ])
    expect(closes).toEqual(["/workspace/main"])
    expect(routes).toEqual(["/"])
  })

  test("deleting a workspace removes it from both sandboxes and workspaces immediately", async () => {
    const { props, nav, cleaned, data } = make("/workspace/feature")
    data.project[0] = {
      id: "p1",
      worktree: "/workspace/main",
      sandboxes: ["/workspace/feature"],
      workspaces: {
        "/workspace/feature": {
          id: "w1",
          directory: "/workspace/feature",
          kind: "local",
        },
      },
    }

    createProjectActions(props, nav).handleDeleteWorkspace({
      directory: "/workspace/feature",
      projectWorktree: "/workspace/main",
      isMain: false,
      isCloud: false,
    } as any)

    expect(deleteDialogProps).toBeDefined()
    await deleteDialogProps!.onDelete("/workspace/feature")

    expect(data.project[0]?.sandboxes).toEqual([])
    expect(data.project[0]?.workspaces).toEqual({})
    expect(cleaned).toEqual([{ directory: "/workspace/feature", projectId: "p1" }])
  })
})
