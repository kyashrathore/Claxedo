import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { queryClient } from "../../shared/query/query-client"
import { shellDataKeys } from "../../shell/data/keys"
import { directorySessionCacheQueryOptions, setSessionStatusQueryData } from "../../shell/data/queries"
import { workspaceSessionRoute } from "../../shell/identity/route"
import type { ClaxedoEvent } from "../../context/claxedo-events"
import type { ProjectItem, WorkspaceItem } from "../rail/domain-types"
import type { ProjectActionProps } from "./project-actions"

let createProjectActions: typeof import("./project-actions").createProjectActions
let WorktreeState: typeof import("@/utils/worktree").Worktree
let deleteDialogProps: undefined | { onDelete: (dir: string) => Promise<void> | void }
const worktreeStates = new Map<string, { status: "pending" | "ready" } | { status: "failed"; message: string }>()
const worktreeWaiters = new Map<string, Array<(state: { status: "pending" | "ready" } | { status: "failed"; message: string }) => void>>()

const toasts: Array<{ title?: string; description?: string }> = []
const mockApi: {
  post: (url: string, body?: unknown) => Promise<unknown>
  get: (url: string) => Promise<unknown>
} = {
  post: async () => {
    throw new Error("mock api post not configured")
  },
  get: async () => {
    throw new Error("mock api get not configured")
  },
}

function project(input: Pick<ProjectItem, "id" | "worktree"> & Partial<ProjectItem>): ProjectItem {
  return input
}

function workspace(input: Pick<WorkspaceItem, "directory"> & Partial<WorkspaceItem>): WorkspaceItem {
  return {
    id: input.directory,
    ...input,
  }
}

type PendingWorkspaceStatus = {
  status: "pending"
}

beforeAll(async () => {
  mock.module("@/components/dialogs/settings", () => ({
    DialogSettings: () => null,
  }))

  mock.module("@opencode-ai/ui/toast", () => ({
    showToast: (input: { title?: string; description?: string }) => {
      toasts.push(input)
      return 0
    },
  }))

  mock.module("@/utils/worktree", () => ({
    Worktree: {
      get: (directory: string) => worktreeStates.get(directory),
      pending: (directory: string) => {
        if (!worktreeStates.has(directory)) worktreeStates.set(directory, { status: "pending" })
      },
      ready: (directory: string) => {
        const state = { status: "ready" as const }
        worktreeStates.set(directory, state)
        worktreeWaiters.get(directory)?.splice(0).forEach((resolve) => resolve(state))
      },
      failed: (directory: string, message: string) => {
        const state = { status: "failed" as const, message }
        worktreeStates.set(directory, state)
        worktreeWaiters.get(directory)?.splice(0).forEach((resolve) => resolve(state))
      },
      wait: (directory: string) => {
        const state = worktreeStates.get(directory)
        if (state && state.status !== "pending") return Promise.resolve(state)
        return new Promise((resolve) => {
          const waiters = worktreeWaiters.get(directory) ?? []
          waiters.push(resolve)
          worktreeWaiters.set(directory, waiters)
        })
      },
    },
    validWorktree: () => true,
  }))

  mock.module("@/components/dialogs/select-directory", () => ({
    DialogSelectDirectory: () => null,
  }))

  mock.module("../../components/dialogs/create-cloud-workspace", () => ({
    DialogCreateCloudWorkspace: () => null,
  }))

  mock.module("../../components/dialogs/new-project", () => ({
    DialogNewProject: () => null,
  }))

  mock.module("../components/dialogs", () => ({
    DialogDeleteSession: () => null,
    DialogDeleteWorkspace: (props: { onDelete: (dir: string) => Promise<void> | void }) => {
      deleteDialogProps = props
      return null
    },
    DialogEditProject: () => null,
    DialogRecoverWorkspace: () => null,
  }))

  // Shadow `../../utils/api` with the full export shape so a mock leaked from
  // another test file in the same suite run cannot strip exports we need.
  mock.module("../../utils/api", () => ({
    api: mockApi,
    authFetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
    getClaxedoServerUrl: () => "http://test.local",
    getDefaultBaseUrl: () => "http://test.local",
    isDemoMode: () => false,
    isDemoPath: () => false,
    isEmbedMode: () => false,
    fixDir: (input: string | undefined) => input,
    configureApiRuntime: () => undefined,
    resetApiRuntime: () => undefined,
    normalizeUrl: (u: string | undefined) => u?.trim().replace(/\/+$/, "") || undefined,
  }))

  const mod = await import("./project-actions")
  createProjectActions = mod.createProjectActions
  WorktreeState = (await import("@/utils/worktree")).Worktree
})

beforeEach(() => {
  queryClient.clear()
  toasts.length = 0
  deleteDialogProps = undefined
  worktreeStates.clear()
  worktreeWaiters.clear()
  mockApi.post = async () => {
    throw new Error("mock api post not configured")
  }
  mockApi.get = async (): Promise<PendingWorkspaceStatus> => ({ status: "pending" })
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
  const removes: string[] = []
  const workspaceDeletes: Array<{ url: string; method?: string }> = []
  const worktreeRemoves: unknown[] = []
  const cleaned: Array<{ directory: string; projectId?: string }> = []
  const shows: unknown[] = []
  const cacheEnsures: string[] = []
  const cacheRefreshes: string[] = []
  const bootstraps: string[] = []
  const worktreeReady = { status: "loading" as "loading" | "partial" | "complete" }
  const data: { project: ProjectItem[] } = {
    project: [project({
      id: "p1",
      worktree: "/workspace/main",
      sandboxes: [],
      workspaces: {},
    })],
  }
  const paneWorktrees: Record<string, { default: string | null; pinned: string | null }> = {
    g1: { default: null, pinned: null },
  }
  const projectsQueryKey = ["test", "projects", dir] as const
  queryClient.setQueryData(projectsQueryKey, data.project)

  const props: ProjectActionProps = {
    flowLog: () => undefined,
    params: {},
    routeWorkspaceId: () => "/workspace/main",
    activeWorkspaceId: () => "/workspace/main",
    activeProjectId: () => "p1",
    projects: () => data.project,
    navigate: (path: string) => routes.push(path),
    state: {
      wb: {
        state: {
          focusedPaneId: "g1",
          panes: [{ id: "g1" }],
        },
      },
      workspace: {
        setPaneWorktreePinned: (paneId: string, value: string | null) => {
          paneWorktrees[paneId] = { ...(paneWorktrees[paneId] ?? { default: null, pinned: null }), pinned: value }
        },
        setPaneWorktreeDefault: (paneId: string, value: string | null) => {
          paneWorktrees[paneId] = { ...(paneWorktrees[paneId] ?? { default: null, pinned: null }), default: value }
        },
        paneWorktree: (paneId: string) => paneWorktrees[paneId] ?? { default: null, pinned: null },
        recordAccess: () => undefined,
        cleanupRecency: () => undefined,
        cleanupDeletedWorktree: (directory: string, projectId?: string) => {
          cleaned.push({ directory, projectId })
          for (const [paneId, entry] of Object.entries(paneWorktrees)) {
            paneWorktrees[paneId] = {
              default: entry.default === directory ? null : entry.default,
              pinned: entry.pinned === directory ? null : entry.pinned,
            }
          }
        },
      },
      layout: {
        openSession: (directory: string, sessionId: string, title: string) => {
          adds.push({ directory, sessionId, title })
          acts.push("tab-new")
          return "tab-new"
        },
        closeContent: () => undefined,
      },
      meta: {
        findAll: () => [],
      },
    },
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
          remove: async (input: unknown) => {
            worktreeRemoves.push(input)
            return true
          },
        },
      },
    },
    layout: {
      projects: {
        open: () => undefined,
        close: (directory: string) => closes.push(directory),
        remove: (directory: string) => removes.push(directory),
      },
    },
    platform: {
      platform: "web",
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        workspaceDeletes.push({
          url: input instanceof Request ? input.url : String(input),
          method: init?.method ?? (input instanceof Request ? input.method : undefined),
        })
        return Response.json({ ok: true })
      },
      openLink: () => undefined,
    },
    config: {},
    directorySessionCacheActions: {
      ensure: async (input: { directory: string }) => {
        cacheEnsures.push(input.directory)
      },
      refresh: async (input: { directory: string }) => {
        cacheRefreshes.push(input.directory)
      },
    },
    globalBootstrapActions: {
      bootstrap: async () => {
        bootstraps.push("bootstrap")
      },
    },
    projectInventoryActions: {
      query: () => ({
        queryKey: projectsQueryKey,
      }),
      queryKey: () => projectsQueryKey,
    },
  }

  const nav = (path: string, reason: string, details?: Record<string, unknown>) => {
    navs.push({ path, reason, details })
  }

  return { props, adds, acts, navs, nav, worktreeReady, routes, closes, removes, workspaceDeletes, worktreeRemoves, cleaned, shows, data, projectsQueryKey, cacheEnsures, cacheRefreshes, bootstraps, paneWorktrees }
}

describe("createProjectActions.handleNewWorkspace", () => {
  test("opens the new session tab after a successful worktree create without an external readiness signal", async () => {
    // Regression for core-workspace-lifecycle:544. A resolved
    // client.worktree.create means the worktree exists on disk, so the flow
    // must proceed to open the session tab on its own. Nothing in production
    // ever flips WorktreeState pending→ready, so the previous code awaited
    // WorktreeState.wait() forever — the old test masked the hang by calling
    // WorktreeState.ready(dir) by hand, a signal production never emits.
    const dir = `/workspace/feature-${Date.now().toString(36)}`
    const { props, adds, acts, navs, nav } = make(dir)

    const result = await createProjectActions(props, nav).handleNewWorkspace(project({
      id: "p1",
      worktree: "/workspace/main",
      sandboxes: [],
    }))

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
        path: workspaceSessionRoute(dir),
        reason: "new-workspace-created",
        details: {
          projectId: "p1",
          created: dir,
          tabId: "tab-new",
        },
      },
    ])
  })

  test("shows an error and skips tab creation when the worktree create call rejects", async () => {
    const dir = `/workspace/feature-${Date.now().toString(36)}-fail`
    const { props, adds, acts, navs, nav } = make(dir)
    // The real production failure path is a rejected create call (caught by
    // handleError), not an externally-injected WorktreeState.failed() that
    // nothing in production emits.
    props.globalSDK.client.worktree.create = async () => {
      throw new Error("boom")
    }
    toasts.length = 0

    const result = await createProjectActions(props, nav).handleNewWorkspace(project({
      id: "p1",
      worktree: "/workspace/main",
      sandboxes: [],
    }))

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

  test("direct local workspace creation warms the directory session cache before opening a session", async () => {
    const dir = `/workspace/feature-${Date.now().toString(36)}-direct`
    const { props, adds, navs, nav, cacheEnsures } = make(dir)
    const progress: string[] = []

    const result = await createProjectActions(props, nav).handleNewLocalWorkspace(
      project({ id: "p1", worktree: "/workspace/main", sandboxes: [] }),
      (step) => progress.push(step),
      "feature",
    )

    expect(cacheEnsures).toEqual([dir])
    expect(progress).toEqual(["creating", "ready", "redirecting"])
    expect(result).toEqual({
      id: dir,
      directory: dir,
      name: "feature",
      projectWorktree: "/workspace/main",
      canDelete: true,
      available: true,
    })
    expect(adds).toEqual([{ directory: dir, sessionId: "new", title: "New Session" }])
    expect(navs).toEqual([
      {
        path: workspaceSessionRoute(dir),
        reason: "new-workspace-created",
        details: {
          projectId: "p1",
          created: dir,
          tabId: "tab-new",
        },
      },
    ])
  })

  test("direct cloud workspace progress replays backend events emitted before create returns", async () => {
    const { props, adds, navs, nav } = make("/workspace/main")
    const progress: string[] = []
    let listener: ((event: Extract<ClaxedoEvent, { type: "provision" }>) => void) | undefined
    let releaseCreate: (() => void) | undefined

    props.events = {
      connected: () => true,
      on: (type, cb) => {
        if (type === "provision") {
          listener = cb as (event: Extract<ClaxedoEvent, { type: "provision" }>) => void
        }
        return () => {
          listener = undefined
        }
      },
    }
    mockApi.post = async () => {
      await new Promise<void>((resolve) => {
        releaseCreate = resolve
      })
      return {
        workspaceId: "ws_cloud_1",
        directory: "workspace:ws_cloud_1",
      }
    }

    const run = createProjectActions(props, nav).handleNewCloudWorkspace(
      project({ id: "p1", worktree: "/workspace/main", sandboxes: [] }),
      (step) => progress.push(step),
      "feature-cloud",
    )

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(progress).toEqual([])

    listener?.({ type: "provision", workspaceId: "ws_cloud_1", step: "acquiring_sandbox", ts: Date.now() })
    listener?.({ type: "provision", workspaceId: "ws_cloud_1", step: "cloning", ts: Date.now() })
    expect(progress).toEqual([])

    releaseCreate?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(progress).toEqual(["acquiring_sandbox", "cloning"])

    listener?.({ type: "provision", workspaceId: "ws_cloud_1", step: "ready", ts: Date.now() })

    const result = await run

    expect(progress).toEqual(["acquiring_sandbox", "cloning", "ready", "redirecting"])
    expect(result).toEqual({
      id: "ws_cloud_1",
      workspaceId: "ws_cloud_1",
      directory: "workspace:ws_cloud_1",
      name: "feature-cloud",
      projectWorktree: "/workspace/main",
      canDelete: true,
    })
    expect(adds).toEqual([{ directory: "workspace:ws_cloud_1", sessionId: "new", title: "New Session" }])
    expect(navs).toEqual([
      {
        path: workspaceSessionRoute("workspace:ws_cloud_1"),
        reason: "new-workspace-created",
        details: {
          projectId: "p1",
          created: "workspace:ws_cloud_1",
          tabId: "tab-new",
        },
      },
    ])
  })

  test("removing the active project deletes it from the workspace store and navigates away", () => {
    const { props, nav, routes, closes, removes, workspaceDeletes, cleaned } = make("/workspace/feature")
    props.activeProjectId = () => "/workspace/main"

    createProjectActions(props, nav).handleRemoveProject(project({
      id: "p1",
      worktree: "/workspace/main",
      sandboxes: ["/workspace/formlink", "/workspace/feature"],
    }))

    expect(cleaned).toEqual([
      { directory: "/workspace/main", projectId: "p1" },
      { directory: "/workspace/formlink", projectId: "p1" },
      { directory: "/workspace/feature", projectId: "p1" },
    ])
    expect(closes).toEqual(["/workspace/main"])
    expect(removes).toEqual([])
    expect(workspaceDeletes).toEqual([{
      url: "http://test.local/api/workspace/p1",
      method: "DELETE",
    }])
    expect(routes).toEqual(["/"])
  })

  test("deleting a workspace removes it from both sandboxes and workspaces immediately", async () => {
    const { props, nav, cleaned, data, projectsQueryKey } = make("/workspace/feature")
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
    queryClient.setQueryData(projectsQueryKey, data.project)
    queryClient.setQueryData(directorySessionCacheQueryOptions({ directory: "/workspace/feature" }).queryKey, {
      at: Date.now(),
      limit: 40,
      total: 1,
      session: [{ id: "ses_1" }],
    })
    setSessionStatusQueryData({ queryClient, sessionId: "ses_1", status: { type: "busy" } })

    createProjectActions(props, nav).handleDeleteWorkspace(workspace({
      directory: "/workspace/feature",
      projectWorktree: "/workspace/main",
      isMain: false,
      isCloud: false,
    }))

    expect(deleteDialogProps).toBeDefined()
    await deleteDialogProps!.onDelete("/workspace/feature")

    expect(queryClient.getQueryData<ProjectFixture[]>(projectsQueryKey)?.[0]?.sandboxes).toEqual([])
    expect(queryClient.getQueryData<ProjectFixture[]>(projectsQueryKey)?.[0]?.workspaces).toEqual({})
    expect(queryClient.getQueryData(directorySessionCacheQueryOptions({ directory: "/workspace/feature" }).queryKey)).toBeUndefined()
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_1", "status"))).toBeUndefined()
    expect(data.project[0]?.sandboxes).toEqual(["/workspace/feature"])
    expect(cleaned).toEqual([{ directory: "/workspace/feature", projectId: "p1" }])
  })

  test("deleting the active workspace clears pane selection and navigates away without reload", async () => {
    const { props, nav, routes, worktreeRemoves, cleaned, data, projectsQueryKey, paneWorktrees } = make("/workspace/feature")
    props.activeWorkspaceId = () => "/workspace/feature"
    paneWorktrees.g1 = { default: "/workspace/feature", pinned: "/workspace/feature" }
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
    queryClient.setQueryData(projectsQueryKey, data.project)

    createProjectActions(props, nav).handleDeleteWorkspace(workspace({
      directory: "/workspace/feature",
      projectWorktree: "/workspace/main",
      isMain: false,
      isCloud: false,
    }))

    expect(deleteDialogProps).toBeDefined()
    await deleteDialogProps!.onDelete("/workspace/feature")

    expect(worktreeRemoves).toEqual([{
      directory: "/workspace/main",
      worktreeRemoveInput: { directory: "/workspace/feature" },
    }])
    expect(paneWorktrees.g1).toEqual({ default: "/workspace/main", pinned: null })
    expect(cleaned).toEqual([{ directory: "/workspace/feature", projectId: "p1" }])
    expect(routes).toEqual(["/"])
    expect(queryClient.getQueryData<ProjectFixture[]>(projectsQueryKey)?.[0]?.sandboxes).toEqual([])
    expect(queryClient.getQueryData<ProjectFixture[]>(projectsQueryKey)?.[0]?.workspaces).toEqual({})
  })

  test("deleting a cloud main workspace destroys the sandbox through the gateway path", async () => {
    const { props, nav, routes, removes } = make("workspace:ws_cloud")
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; method?: string }> = []
    globalThis.fetch = (async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method,
      })
      return new Response("{}")
    }) as typeof fetch

    try {
      createProjectActions(props, nav).handleDeleteWorkspace(workspace({
        directory: "workspace:ws_cloud",
        projectWorktree: "workspace:ws_cloud",
        isMain: true,
        isCloud: true,
      }))

      expect(deleteDialogProps).toBeDefined()
      await deleteDialogProps!.onDelete("workspace:ws_cloud")
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(calls).toEqual([{
      url: "/api/experimental/sandbox?directory=workspace%3Aws_cloud",
      method: "DELETE",
    }])
    expect(removes).toEqual(["workspace:ws_cloud"])
    expect(routes).toEqual(["/"])
  })
})
