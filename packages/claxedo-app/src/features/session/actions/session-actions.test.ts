import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { sessionRoute, workspaceRoute, workspaceSessionRoute } from "@/platform/identity/route"
import { getLocalSelectionHandoff, localDraftSelectionHandoffID, resetLocalSelectionHandoffForTest } from "../store/local-selection-handoff"
import { sessionConfigSelectionQueryKey } from "../store/session-config-selection"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { shellDataKeys } from "@/platform/sync/keys"
import { configureAppPortsForTest } from "@/app/integrations/test-support/app-ports-stub"
import { directorySessionCacheQueryOptions } from "../data/sync/queries"
import {
  createSessionInventorySnapshotValue,
  readSessionInventoryQueryData,
  setSessionInventoryQueryData,
} from "../data/sync/inventory-writers"
import type { SessionListResponse } from "../data/query/session-list"
import { composerFocus } from "../composer/ui/composer-focus"

const activeSelectionScope = {
  sessionID: "ses_active",
  directory: "/workspace/main",
  serverUrl: "http://127.0.0.1:3001",
}
const realComposerFocusSchedule = composerFocus.schedule

beforeEach(() => configureAppPortsForTest())

// `mock.module` replaces a module PROCESS-WIDE and bun never unwinds it at the
// end of a file. The cloud-startup-view stub below flips
// `isForbiddenConnectionError` to a constant `false`, and the workspaces app
// ports resolve that export through a call-time `require`, so leaving the stub
// installed makes workspace-connection.ts classify a 403 as "failed" instead of
// "forbidden" for every test file that runs after this one. Capture the real
// module up front and put it back when this file is done.
const realCloudStartupModule = {
  ...(await import(`${import.meta.dir}/../ui/components/cloud-startup-view.tsx?session-actions-restore`)),
}

afterAll(() => {
  mock.module("@/features/session/ui/components/cloud-startup-view", () => realCloudStartupModule)
})

let createSessionActions: typeof import("./session-actions").createSessionActions

beforeAll(async () => {
  mock.module("@opencode-ai/ui/dialog", () => ({
    Dialog: () => null,
  }))
  mock.module("@opencode-ai/ui/toast", () => ({
    showToast: () => 0,
  }))
  mock.module("../../../app/dialogs/index", () => ({
    DialogDeleteSession: () => null,
    DialogRecoverWorkspace: () => null,
  }))
  mock.module("@/features/session/ui/components/cloud-startup-view", () => ({
    CloudStartupView: () => null,
    isForbiddenConnectionError: () => false,
  }))
  const mod = await import("./session-actions")
  createSessionActions = mod.createSessionActions
})

function makeProps() {
  const openedProjects: string[] = []
  const workspaceDefaults: Array<{ paneId: string; directory: string | null }> = []
  const workspacePanels: Array<Record<string, unknown>> = []
  const sessions: Array<{ directory: string; sessionId: string; title: string; opts?: Record<string, unknown> }> = []
  const navs: Array<{ path: string; reason: string; details?: Record<string, unknown> }> = []

  const props = {
    flowLog: () => undefined,
    params: {},
    activeDirectory: () => "/workspace/main",
    activeProjectId: () => "p1",
    workspaceRouteId: () => "p1",
    workspaceKindForRoute: () => undefined,
    projects: () => [{ id: "p1", worktree: "/workspace/main" }],
    navigate: () => undefined,
    dialog: {},
    globalSDK: {
      url: "http://127.0.0.1:3001",
      client: {
        session: {
          create: async () => ({ data: { id: "ses_review_1" } }),
        },
      },
    },
    globalSync: {},
    directorySessionCacheActions: {
      ensure: () => undefined,
      refresh: () => undefined,
    },
    layout: {
      projects: {
        open: (directory: string) => {
          openedProjects.push(directory)
        },
      },
    },
    platform: {},
    config: {},
    state: {
      wb: {
        state: { focusedPaneId: "pane-1" },
        selectors: {
          focusedContent: () => "content-active",
        },
      },
      workspace: {
        recordAccess: () => undefined,
        setPaneWorktreePinned: () => undefined,
        setPaneWorktreeDefault: (paneId: string, directory: string | null) => {
          workspaceDefaults.push({ paneId, directory })
        },
      },
      meta: {
        find: () => undefined,
        get: () => undefined,
      },
      layout: {
        openSession: (directory: string, sessionId: string, title: string, opts?: Record<string, unknown>) => {
          sessions.push({
            directory,
            sessionId,
            title,
            ...(opts ? { opts } : {}),
          })
          return "content-new"
        },
      },
      workspacePanel: {
        open: (input: Record<string, unknown>) => {
          workspacePanels.push(input)
        },
      },
    },
    // as-any: test double implements only the API surface exercised by this test.
  } as any

  const nav = (path: string, reason: string, details?: Record<string, unknown>) => {
    navs.push({ path, reason, details })
  }

  return { props, openedProjects, workspaceDefaults, workspacePanels, sessions, navs, nav }
}

describe("createSessionActions", () => {
  afterEach(() => {
    resetLocalSelectionHandoffForTest()
    queryClient.clear()
    composerFocus.schedule = realComposerFocusSchedule
    document.body.innerHTML = ""
  })

  test("new session creation navigates by typed workspace draft route", async () => {
    const { props, openedProjects, workspaceDefaults, sessions, navs, nav } = makeProps()

    await createSessionActions(props, nav).handleNewSession("/workspace/main")

    expect(openedProjects).toEqual(["/workspace/main"])
    expect(workspaceDefaults).toEqual([{ paneId: "pane-1", directory: "/workspace/main" }])
    expect(sessions).toEqual([{
      directory: "/workspace/main",
      sessionId: "new",
      title: "New Session",
      opts: {
        workspaceRouteId: "p1",
        sessionRef: {
          sessionId: "new",
          host: "workspace",
          cwd: "/workspace/main",
          toolSandbox: { kind: "local", cwd: "/workspace/main" },
        },
      },
    }])
    expect(navs).toEqual([
      {
        path: workspaceSessionRoute("p1"),
        reason: "new-session",
        details: { workspaceDir: "/workspace/main" },
      },
    ])
  })

  test("new session creation hands activation focus to the composer", async () => {
    const { props, nav } = makeProps()
    const queue: Array<() => void> = []
    composerFocus.schedule = (run) => queue.push(run)
    const origin = document.createElement("button")
    const destination = document.createElement("div")
    destination.dataset.sessionId = "new"
    const editor = document.createElement("div")
    editor.setAttribute("data-component", "prompt-input")
    editor.setAttribute("contenteditable", "true")
    destination.append(editor)
    document.body.append(origin, destination)
    origin.focus()

    await createSessionActions(props, nav).handleNewSession("/workspace/main")
    while (queue.length > 0) queue.shift()?.()

    expect(document.activeElement).toBe(editor)
  })

  test("selected workspace identity is used without rediscovering it from an ambiguous directory", async () => {
    const { props, openedProjects, sessions, navs, nav } = makeProps()
    props.workspaceRouteId = () => undefined
    props.projects = () => [
      { id: "p1", worktree: "/workspace/shared" },
      { id: "p2", worktree: "/workspace/shared" },
    ]

    await createSessionActions(props, nav).handleNewSession("/workspace/shared", undefined, "p2")

    expect(openedProjects).toEqual(["/workspace/shared"])
    expect(sessions).toEqual([{
      directory: "/workspace/shared",
      sessionId: "new",
      title: "New Session",
      opts: {
        workspaceRouteId: "p2",
        sessionRef: {
          sessionId: "new",
          host: "workspace",
          cwd: "/workspace/shared",
          toolSandbox: { kind: "local", cwd: "/workspace/shared" },
        },
      },
    }])
    expect(navs.map((item) => item.path)).toEqual([workspaceSessionRoute("p2")])
  })

  test("does not mutate layout before a workspace route identity exists", async () => {
    const { props, openedProjects, sessions, navs, nav } = makeProps()
    props.workspaceRouteId = () => undefined

    await createSessionActions(props, nav).handleNewSession("/workspace/main")

    expect(openedProjects).toEqual([])
    expect(sessions).toEqual([])
    expect(navs).toEqual([])
  })

  test("new session inherits focused session model selection into the draft", async () => {
    const { props, nav } = makeProps()
    props.state.meta.get = () => ({
      id: "content-active",
      type: "session",
      directory: "/workspace/main",
      sessionId: "ses_active",
    })
    queryClient.setQueryData(sessionConfigSelectionQueryKey(activeSelectionScope), {
      agent: "build",
      model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
      variant: null,
    })

    await createSessionActions(props, nav).handleNewSession("/workspace/main")

    expect(getLocalSelectionHandoff(localDraftSelectionHandoffID("/workspace/main"))).toEqual({
      agent: "build",
      model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
      variant: null,
    })
  })

  test("new review creation navigates by canonical session identity", async () => {
    const { props, openedProjects, workspaceDefaults, workspacePanels, navs, nav } = makeProps()

    await createSessionActions(props, nav).handleNewReview("/workspace/main")

    expect(openedProjects).toEqual(["/workspace/main"])
    expect(workspaceDefaults).toEqual([{ paneId: "pane-1", directory: "/workspace/main" }])
    expect(workspacePanels).toEqual([
      {
        workspaceDir: "/workspace/main",
        targetPaneId: "pane-1",
        navigator: null,
        focus: null,
      },
    ])
    expect(navs).toEqual([
      {
        path: "/s/ses_review_1",
        reason: "new-review",
        details: {
          workspaceDir: "/workspace/main",
          contentId: "content-active",
        },
      },
    ])
  })

  test("session selection passes explicit cloud workspace session refs", () => {
    const { props, sessions, nav } = makeProps()
    props.projects = () => [{
      id: "p1",
      worktree: "/workspace/main",
      workspaces: {
        "workspace:ws_cloud": {
          id: "ws_cloud",
          workspaceId: "ws_cloud",
          directory: "workspace:ws_cloud",
          kind: "cloud",
        },
      },
    }]

    createSessionActions(props, nav).handleSessionSelect("workspace:ws_cloud", "ses_cloud")

    expect(sessions).toEqual([{
      directory: "workspace:ws_cloud",
      sessionId: "ses_cloud",
      title: "Session",
      opts: {
        sessionRef: {
          sessionId: "ses_cloud",
          host: "workspace",
          workspaceId: "ws_cloud",
          toolSandbox: {
            kind: "workspace",
            workspaceId: "ws_cloud",
            hosting: "cloud",
          },
        },
      },
    }])
  })

  test("archiving the active session navigates to the next visible session", async () => {
    const { props, navs, nav } = makeProps()
    // Sidebar selection updates browser history directly; focused workbench
    // state must still identify the active session if router params lag behind.
    props.params = {}
    props.globalSDK.client.session.update = async () => ({ data: {} })
    props.workspaceRouteId = () => "ws_main"
    props.state.meta.find = () => ({
      id: "content-active",
      type: "session",
      directory: "/workspace/main",
      sessionId: "ses_active",
    })
    props.state.layout.closeContent = () => undefined

    const archived = await createSessionActions(props, nav).handleArchiveSession({
      id: "ses_active",
      title: "Active",
      directory: "/workspace/main",
      projectID: "p1",
    }, "ses_next")

    expect(archived).toBe(true)
    expect(navs).toEqual([{
      path: sessionRoute("ses_next"),
      reason: "archive-session:next",
      details: { archivedSessionId: "ses_active", nextSessionId: "ses_next" },
    }])
  })

  test("archiving the only active session navigates to its canonical workspace root", async () => {
    const { props, navs, nav } = makeProps()
    props.params = { id: "ses_active" }
    props.globalSDK.client.session.update = async () => ({ data: {} })
    props.workspaceRouteId = () => "ws_main"
    props.state.meta.find = () => ({
      id: "content-active",
      type: "session",
      directory: "/workspace/main",
      sessionId: "ses_active",
    })
    props.state.layout.closeContent = () => undefined
    queryClient.setQueryData(shellDataKeys.sessionId("ses_active", "messages"), {
      messages: [{ id: "msg_cached" }],
    })
    queryClient.setQueryData(directorySessionCacheQueryOptions({ directory: "/workspace/main" }).queryKey, {
      at: Date.now(),
      limit: 40,
      total: 1,
      session: [{
        id: "ses_active",
        slug: "ses_active",
        version: "test",
        directory: "/workspace/main",
        projectID: "p1",
        title: "Only session",
        time: { created: 1, updated: 1 },
      }],
    })
    setSessionInventoryQueryData({
      baseUrl: props.globalSDK.url,
      value: createSessionInventorySnapshotValue({
        loaded: true,
        rows: [{
          id: "ses_active",
          title: "Only session",
          directory: "/workspace/main",
          projectID: "p1",
          tags: [],
          attachments: [],
          time: { created: 1, updated: 1 },
        }],
      }),
    })
    const listKey = queryKeys.shell.sessionList(props.globalSDK.url, {
      scope: "workspace",
      directory: "/workspace/main",
      archived: "active",
      limit: 50,
    })
    queryClient.setQueryData<SessionListResponse>(listKey, {
      view: { scope: "workspace", groupBy: "none", sort: "updated_desc", limit: 50 },
      items: [{
        sessionId: "ses_active",
        sessionRef: "local:/workspace/main:session:ses_active",
        title: "Only session",
        directory: "/workspace/main",
        projectId: "p1",
        createdAt: 1,
        updatedAt: 1,
        tags: [],
        attachments: [],
      }],
      totalKnown: 1,
    })

    const archived = await createSessionActions(props, nav).handleArchiveSession({
      id: "ses_active",
      title: "Only session",
      directory: "/workspace/main",
      projectID: "p1",
    })

    expect(archived).toBe(true)
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_active", "messages"))).toBeUndefined()
    expect(queryClient.getQueryData<{ session: Array<{ id: string }> }>(
      directorySessionCacheQueryOptions({ directory: "/workspace/main" }).queryKey,
    )?.session).toEqual([])
    const inventory = readSessionInventoryQueryData({ baseUrl: props.globalSDK.url })
    expect(inventory.sessions.some((item) => item.id === "ses_active")).toBe(false)
    expect(Object.values(inventory.byProject).flat().some((item) => item.id === "ses_active")).toBe(false)
    expect(Object.values(inventory.byWorkspace).flatMap((group) => group.sessions).some((item) => item.id === "ses_active")).toBe(false)
    expect(queryClient.getQueryData<SessionListResponse>(listKey)?.items).toEqual([])
    expect(navs).toEqual([{
      path: workspaceRoute("ws_main"),
      reason: "archive-session:workspace",
      details: { archivedSessionId: "ses_active", workspaceId: "ws_main" },
    }])
  })

  test("archiving a background session keeps the current session URL", async () => {
    const { props, navs, nav } = makeProps()
    props.params = { id: "ses_active" }
    props.globalSDK.client.session.update = async () => ({ data: {} })

    const archived = await createSessionActions(props, nav).handleArchiveSession({
      id: "ses_background",
      title: "Background",
      directory: "/workspace/main",
      projectID: "p1",
    }, "ses_next")

    expect(archived).toBe(true)
    expect(navs).toEqual([])
  })
})
