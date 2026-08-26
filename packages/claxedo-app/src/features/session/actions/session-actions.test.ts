import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { workspaceSessionRoute } from "@/platform/identity/route"
import {
  getLocalSelectionHandoff,
  localDraftSelectionHandoffID,
  resetLocalSelectionHandoffForTest,
} from "../store/local-selection-handoff"
import { sessionConfigSelectionQueryKey } from "../store/session-config-selection"
import { queryClient } from "@/platform/query/query-client"
import { configureAppPortsForTest } from "@/app/integrations/test-support/app-ports-stub"

const activeSelectionScope = {
  sessionID: "ses_active",
  directory: "/workspace/main",
  serverUrl: "http://127.0.0.1:3001",
}

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
    queryClient.removeQueries({ queryKey: sessionConfigSelectionQueryKey(activeSelectionScope), exact: true })
  })

  test("startup new-session creation routes by the authoritative local workspace id", async () => {
    const { props, openedProjects, workspaceDefaults, sessions, navs, nav } = makeProps()
    props.projects = () => [
      {
        id: "p1",
        worktree: "/workspace/main",
        workspaces: {
          "ws-local-main": {
            id: "ws-local-main",
            directory: "/workspace/main",
            kind: "local",
          },
        },
      },
    ]

    await createSessionActions(props, nav).handleNewSession("/workspace/main")

    expect(openedProjects).toEqual(["/workspace/main"])
    expect(workspaceDefaults).toEqual([{ paneId: "pane-1", directory: "/workspace/main" }])
    expect(sessions).toEqual([{ directory: "/workspace/main", sessionId: "new", title: "New Session" }])
    expect(navs).toEqual([
      {
        path: workspaceSessionRoute("ws-local-main"),
        reason: "new-session",
        details: { workspaceDir: "/workspace/main" },
      },
    ])
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
    props.projects = () => [
      {
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
      },
    ]

    createSessionActions(props, nav).handleSessionSelect("workspace:ws_cloud", "ses_cloud")

    expect(sessions).toEqual([
      {
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
      },
    ])
  })
})
