import { beforeAll, describe, expect, mock, test } from "bun:test"
import { workspaceSessionRoute } from "../../shell/identity/route"
import type { ProjectItem } from "../rail/rail-sidebar"
import type { WorkspaceActionProps } from "./workspace-actions"

let createWorkspaceActions: typeof import("./workspace-actions").createWorkspaceActions

// This covers the workspace-actions.ts port to the
// modern `state.{wb,workspace,meta,layout}` API. The legacy shape
// (`claxedo.{topTabs,groupTabs,workspaceRecency,worktree,split}`) was
// removed when the Workbench replaced the tabs system.

type ContentMeta =
  | { id: string; type: "session"; directory: string; sessionId?: string; content?: { sessionRef?: unknown } }
  | { id: string; type: "process"; directory: string }

function project(input: Pick<ProjectItem, "id" | "worktree"> & Partial<ProjectItem>): ProjectItem {
  return input
}

beforeAll(async () => {
  mock.module("../components/dialogs", () => ({
    DialogDeleteSession: () => null,
    DialogDeleteWorkspace: () => null,
    DialogEditProject: () => null,
    DialogRecoverWorkspace: () => null,
  }))

  createWorkspaceActions = (await import("./workspace-actions")).createWorkspaceActions
})

function makeProps() {
  const opens: Array<{ directory: string; sessionId: string; title?: string; opts?: Record<string, unknown> }> = []
  const access: Array<{ projectId: string; dir: string }> = []
  const pinned: Array<{ paneId: string; dir: string | null }> = []
  const defaulted: Array<{ paneId: string; dir: string | null }> = []
  const navs: Array<{ path: string; reason: string; details?: Record<string, unknown> }> = []
  const shows: unknown[] = []
  let nextContentId = 0

  let metas: ContentMeta[] = []

  const props: WorkspaceActionProps = {
    flowLog: () => undefined,
    params: {},
    activeWorkspaceId: () => "/workspace/other",
    activeProjectId: () => "p1",
    projects: () => [project({ id: "p1", worktree: "/workspace/main", sandboxes: ["/workspace/feature"] })],
    navigate: (_path: string) => undefined,
    dialog: {
      show: (view: unknown) => shows.push(view),
    },
    globalSDK: {
      client: {
        worktree: {
          create: async () => ({ data: { directory: "/workspace/recovered", name: "recovered" } }),
        },
      },
    },
    layout: {},
    platform: {},
    config: {},
    globalSync: {
      child: (_dir: string) => undefined,
      refreshDirectory: () => undefined,
    },
    directorySessionCacheActions: {
      ensure: () => undefined,
      refresh: () => undefined,
    },
    state: {
      wb: { state: { focusedPaneId: "pane-focused" } },
      workspace: {
        recordAccess: (projectId: string, dir: string) => {
          access.push({ projectId, dir })
        },
        setPaneWorktreePinned: (paneId: string, dir: string | null) => {
          pinned.push({ paneId, dir })
        },
        setPaneWorktreeDefault: (paneId: string, dir: string | null) => {
          defaulted.push({ paneId, dir })
        },
      },
      meta: {
        find: (predicate: (m: ContentMeta) => boolean) => metas.find(predicate),
      },
      layout: {
        openSession: (directory: string, sessionId: string, title?: string, opts?: Record<string, unknown>) => {
          opens.push({
            directory,
            sessionId,
            title,
            ...(opts ? { opts } : {}),
          })
          const id = `content-${++nextContentId}`
          if (sessionId !== "new") {
            // Mimic dedup: existing meta gets returned with its id.
            const existing = metas.find((m) => m.type === "session" && m.directory === directory && m.sessionId === sessionId)
            if (existing) return existing.id
          }
          metas.push({ id, type: "session", directory, sessionId })
          return id
        },
      },
    },
  }

  const nav = (path: string, reason: string, details?: Record<string, unknown>) => {
    navs.push({ path, reason, details })
  }

  const seedMeta = (...next: ContentMeta[]) => {
    metas = next.slice()
  }

  return { props, opens, access, pinned, defaulted, navs, shows, nav, seedMeta }
}

describe("createWorkspaceActions", () => {
  test("opens a fresh new-session for a workspace with no existing session content", () => {
    const { props, opens, access, navs, nav } = makeProps()

    createWorkspaceActions(props, nav).handleWorkspaceSelect(
      project({ id: "p1", worktree: "/workspace/main", sandboxes: ["/workspace/feature"] }),
      "/workspace/feature",
    )

    expect(opens).toEqual([{ directory: "/workspace/feature", sessionId: "new", title: "New Session" }])
    expect(access).toEqual([{ projectId: "p1", dir: "/workspace/feature" }])
    expect(navs).toEqual([
      {
        path: workspaceSessionRoute("/workspace/feature"),
        reason: "workspace-select:new-session",
        details: {
          projectId: "p1",
          workspaceDir: "/workspace/feature",
          contentId: "content-1",
        },
      },
    ])
  })

  test("ignores process meta and routes reused session content canonically", () => {
    const { props, opens, navs, nav, seedMeta } = makeProps()
    seedMeta(
      { id: "content-process", type: "process", directory: "/workspace/feature" },
      { id: "content-session", type: "session", directory: "/workspace/feature", sessionId: "ses-1" },
    )

    createWorkspaceActions(props, nav).handleWorkspaceSelect(
      project({ id: "p1", worktree: "/workspace/main", sandboxes: ["/workspace/feature"] }),
      "/workspace/feature",
    )

    // The "process" meta must not be picked up — only the session meta
    // is a valid reuse target.
    expect(opens).toEqual([{
      directory: "/workspace/feature",
      sessionId: "ses-1",
      title: undefined,
      opts: {
        sessionRef: {
          sessionId: "ses-1",
          host: "workspace",
          cwd: "/workspace/feature",
          toolSandbox: { kind: "local", cwd: "/workspace/feature" },
        },
      },
    }])
    expect(navs).toEqual([
      {
        path: "/s/ses-1",
        reason: "workspace-select:reused-session",
        details: {
          projectId: "p1",
          workspaceDir: "/workspace/feature",
          contentId: "content-session",
        },
      },
    ])
  })

  test("reused cloud workspace sessions carry explicit session refs", () => {
    const { props, opens, nav, seedMeta } = makeProps()
    const cloudProject = project({
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
    })
    props.projects = () => [cloudProject]
    seedMeta({ id: "content-session", type: "session", directory: "workspace:ws_cloud", sessionId: "ses-cloud" })

    createWorkspaceActions(props, nav).handleWorkspaceSelect(cloudProject, "workspace:ws_cloud")

    expect(opens).toEqual([{
      directory: "workspace:ws_cloud",
      sessionId: "ses-cloud",
      title: undefined,
      opts: {
        sessionRef: {
          sessionId: "ses-cloud",
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

  test("binds the focused pane's worktree to the selected workspace", () => {
    const { props, pinned, defaulted, nav } = makeProps()

    createWorkspaceActions(props, nav).handleWorkspaceSelect(
      project({ id: "p1", worktree: "/workspace/main", sandboxes: ["/workspace/feature"] }),
      "/workspace/feature",
    )

    expect(pinned).toEqual([{ paneId: "pane-focused", dir: null }])
    expect(defaulted).toEqual([{ paneId: "pane-focused", dir: "/workspace/feature" }])
  })

  test("shows recovery dialog instead of creating a draft for a missing local workspace", () => {
    const { props, opens, navs, shows, nav } = makeProps()
    props.projects = () => [project({
      id: "p1",
      worktree: "/workspace/main",
      sandboxes: ["/workspace/feature"],
      workspaces: {
        "/workspace/feature": {
          id: "w1",
          directory: "/workspace/feature",
          kind: "local",
          available: false,
        },
      },
    })]

    createWorkspaceActions(props, nav).handleWorkspaceSelect(
      project({ id: "p1", worktree: "/workspace/main", sandboxes: ["/workspace/feature"] }),
      "/workspace/feature",
    )

    expect(shows).toHaveLength(1)
    expect(opens).toEqual([])
    expect(navs).toEqual([])
  })
})
