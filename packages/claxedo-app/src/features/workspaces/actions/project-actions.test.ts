import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"
import { directorySessionCacheQueryOptions, setSessionStatusQueryData } from "../../session/data/sync/queries"
import { workspaceSessionRoute } from "@/platform/identity/route"
import type { ClaxedoEvent } from "../../../app/integrations/claxedo-events"
import type { ProjectItem, WorkspaceItem } from "../../../app/workbench/rail/domain-types"
import type { ProjectActionProps } from "./project-actions"
import { configureAppPortsForTest } from "@/app/integrations/test-support/app-ports-stub"

beforeEach(() => configureAppPortsForTest())

let createProjectActions: typeof import("./project-actions").createProjectActions
let deleteDialogProps: undefined | { onDelete: (dir: string) => Promise<void> | void }
const worktreeStates = new Map<string, { status: "pending" | "ready" } | { status: "failed"; message: string }>()
const worktreeWaiters = new Map<string, Array<(state: { status: "pending" | "ready" } | { status: "failed"; message: string }) => void>>()

const toasts: Array<{ title?: string; description?: string }> = []
/**
 * What `configureApiRuntime({ bearerToken })` would have installed.
 *
 * Destroying a cloud sandbox builds its own `Authorization` header, and it used
 * to import `getAuthToken` from `@/platform/auth/auth-client` to do it — one
 * call site that put Clerk in the local product's bundle. It reads the bearer
 * the build bound into `@/platform/api/api` instead, so this stands in for the
 * binding, and `null` is the local product's real state rather than a stub.
 */
let boundBearer: string | null = null
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
  mock.module("@/app/dialogs/settings", () => ({
    DialogSettings: () => null,
  }))

  mock.module("@opencode-ai/ui/toast", () => ({
    showToast: (input: { title?: string; description?: string }) => {
      toasts.push(input)
      return 0
    },
  }))

  mock.module("@/platform/sync/worktree", () => ({
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

  mock.module("@/app/dialogs/select-directory", () => ({
    DialogSelectDirectory: () => null,
  }))

  mock.module("../../workspaces/ui/dialogs/delete-workspace-dialog", () => ({
    DialogDeleteWorkspace: (props: { onDelete: (dir: string) => Promise<void> | void }) => {
      deleteDialogProps = props
      return null
    },
    DialogEditProject: () => null,
    DialogRecoverWorkspace: () => null,
  }))

  // Shadow `../../utils/api` with the full export shape so a mock leaked from
  // another test file in the same suite run cannot strip exports we need.
  mock.module("@/platform/api/api", () => ({
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
    apiBearerToken: async () => boundBearer,
    normalizeUrl: (u: string | undefined) => u?.trim().replace(/\/+$/, "") || undefined,
  }))

  const mod = await import("./project-actions")
  createProjectActions = mod.createProjectActions
})

beforeEach(() => {
  queryClient.clear()
  toasts.length = 0
  boundBearer = null
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
  // Open tabs, as the metadata registry sees them. Tests that care about tab
  // teardown push entries here before invoking an action.
  const metas: Array<{ id: string; directory?: string; providerDirectory?: string }> = []
  const closedContents: string[] = []
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
    routeDirectory: () => "/workspace/main",
    activeDirectory: () => "/workspace/main",
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
        closeContent: (id: string) => {
          closedContents.push(id)
          const index = metas.findIndex((meta) => meta.id === id)
          if (index >= 0) metas.splice(index, 1)
        },
      },
      meta: {
        findAll: (predicate: (meta: { directory?: string; providerDirectory?: string }) => boolean) =>
          metas.filter(predicate),
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

  return { props, adds, acts, navs, nav, worktreeReady, routes, closes, removes, workspaceDeletes, worktreeRemoves, cleaned, metas, closedContents, shows, data, projectsQueryKey, cacheEnsures, cacheRefreshes, bootstraps, paneWorktrees }
}

describe("createProjectActions", () => {
  // NOTE: handleNewWorkspace (the Local/Cloud picker behind onNewWorkspace) was
  // deleted as dead code — see docs/e2e-decisions.md #16. It had zero reachable
  // UI trigger; the live workspace-creation surface is
  // handleNewLocalWorkspace/handleNewCloudWorkspace below, exercised by the
  // session composer's environment selector (see core-cloud-provisioning.spec.ts
  // and core-workspace-lifecycle.spec.ts).
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

  test("removing a project closes the tabs of every directory it owns", () => {
    const { props, nav, metas, closedContents, cleaned } = make("/workspace/feature")
    // A worktree that only ever appears under `workspaces` — never a sandbox.
    // Walking `worktree + sandboxes` alone left its tabs open in the switcher,
    // pointing at a project that no longer exists.
    metas.push(
      { id: "tab-root", directory: "/workspace/main" },
      { id: "tab-sandbox", directory: "/workspace/formlink" },
      { id: "tab-worktree", directory: "/workspace/wt-1" },
      { id: "tab-draft", providerDirectory: "/workspace/main" },
      { id: "tab-other-project", directory: "/workspace/unrelated" },
    )

    createProjectActions(props, nav).handleRemoveProject(project({
      id: "p1",
      worktree: "/workspace/main",
      sandboxes: ["/workspace/formlink"],
      workspaces: {
        "/workspace/main": { id: "/workspace/main", directory: "/workspace/main" },
        "/workspace/wt-1": { id: "/workspace/wt-1", directory: "/workspace/wt-1" },
      },
    }))

    expect(closedContents.sort()).toEqual(["tab-draft", "tab-root", "tab-sandbox", "tab-worktree"])
    expect(closedContents).not.toContain("tab-other-project")
    expect(metas.map((meta) => meta.id)).toEqual(["tab-other-project"])
    // Each owned directory is purged exactly once, despite `main` appearing in
    // both `worktree` and `workspaces`.
    expect(cleaned).toEqual([
      { directory: "/workspace/main", projectId: "p1" },
      { directory: "/workspace/formlink", projectId: "p1" },
      { directory: "/workspace/wt-1", projectId: "p1" },
    ])
  })

  test("deleting a workspace closes its draft tab as well as its session tabs", async () => {
    const { props, nav, metas, closedContents, data, projectsQueryKey } = make("/workspace/feature")
    data.project[0] = {
      id: "p1",
      worktree: "/workspace/main",
      sandboxes: ["/workspace/feature"],
      workspaces: {
        "/workspace/feature": { id: "/workspace/feature", directory: "/workspace/feature" },
      },
    }
    queryClient.setQueryData(projectsQueryKey, data.project)
    metas.push(
      { id: "tab-session", directory: "/workspace/feature" },
      { id: "tab-draft", providerDirectory: "/workspace/feature" },
      { id: "tab-main", directory: "/workspace/main" },
    )

    createProjectActions(props, nav).handleDeleteWorkspace({
      directory: "/workspace/feature",
      isMain: false,
      isCloud: false,
      projectWorktree: "/workspace/main",
    } as never)
    await deleteDialogProps?.onDelete("/workspace/feature")

    expect(closedContents.sort()).toEqual(["tab-draft", "tab-session"])
    expect(metas.map((meta) => meta.id)).toEqual(["tab-main"])
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
    props.activeDirectory = () => "/workspace/feature"
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

  async function destroyCloudMainWorkspace() {
    const { props, nav, routes, removes } = make("workspace:ws_cloud")
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; method?: string; auth: string | null }> = []
    globalThis.fetch = (async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method,
        auth: new Headers(init?.headers).get("Authorization"),
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

    return { calls, removes, routes }
  }

  test("deleting a cloud main workspace destroys the sandbox through the gateway path", async () => {
    boundBearer = "tok_cloud"

    const { calls, removes, routes } = await destroyCloudMainWorkspace()

    // The bearer is the one the build bound into `@/platform/api/api`, which is
    // the whole point: this action authenticates without importing an identity
    // provider.
    expect(calls).toEqual([{
      url: "/api/experimental/sandbox?directory=workspace%3Aws_cloud",
      method: "DELETE",
      auth: "Bearer tok_cloud",
    }])
    expect(removes).toEqual(["workspace:ws_cloud"])
    expect(routes).toEqual(["/"])
  })

  test("destroys the sandbox unauthenticated when the build bound no bearer source", async () => {
    // The local product's shape. Nothing here fabricates a token; the request
    // goes out without one and the server decides.
    boundBearer = null

    const { calls } = await destroyCloudMainWorkspace()

    expect(calls).toEqual([{
      url: "/api/experimental/sandbox?directory=workspace%3Aws_cloud",
      method: "DELETE",
      auth: null,
    }])
  })
})
