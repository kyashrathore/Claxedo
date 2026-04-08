import { describe, expect, test } from "bun:test"
import { base64Encode } from "@opencode-ai/util/encode"
import { createWorkspaceActions } from "./workspace-actions"

function makeProps() {
  const adds: Array<{ directory: string; sessionId: string; title: string }> = []
  const acts: string[] = []
  const navs: Array<{ path: string; reason: string; details?: Record<string, unknown> }> = []
  const shows: unknown[] = []

  const props = {
    flowLog: () => undefined,
    params: {},
    activeWorkspaceId: () => "/workspace/other",
    activeProjectId: () => "p1",
    projects: () => [{ id: "p1", worktree: "/workspace/main", sandboxes: ["/workspace/feature"] }],
    navigate: (_path: string) => undefined,
    dialog: {
      show: (view: unknown) => shows.push(view),
    },
    globalSDK: {},
    layout: {},
    platform: {},
    config: {},
    globalSync: {
      child: (_dir: string) => undefined,
    },
    claxedo: {
      workspaceRecency: {
        recordAccess: (_projectId: string, _dir: string) => undefined,
      },
      worktree: {
        setPinned: (_dir: string | null) => undefined,
        setDefault: (_dir: string | null) => undefined,
      },
      split: {
        focusedId: () => "g1",
      },
      groupTabs: (_gid: string) => ({
        orderedItems: () => [],
        setActive: (id: string) => acts.push(id),
        addSession: (directory: string, sessionId: string, title: string) => {
          adds.push({ directory, sessionId, title })
          return "tab-new"
        },
      }),
      topTabs: {
        orderedItems: () => [],
        activeId: () => null,
        active: () => undefined,
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

  return { props, adds, acts, navs, shows, nav }
}

describe("createWorkspaceActions", () => {
  test("ignores process tabs when reusing an existing workspace tab", () => {
    const { props, adds, acts, navs, nav } = makeProps()
    props.claxedo.groupTabs = () => ({
      orderedItems: () => [
        {
          id: "tab-process",
          type: "process",
          directory: "/workspace/feature",
          title: "Processes",
          pinned: true,
          closable: false,
        },
      ],
      setActive: (id: string) => acts.push(id),
      addSession: (directory: string, sessionId: string, title: string) => {
        adds.push({ directory, sessionId, title })
        return "tab-new"
      },
    })

    createWorkspaceActions(props, nav).handleWorkspaceSelect(
      { id: "p1", worktree: "/workspace/main", sandboxes: ["/workspace/feature"] } as any,
      "/workspace/feature",
    )

    expect(acts).toEqual(["tab-new"])
    expect(adds).toEqual([{ directory: "/workspace/feature", sessionId: "new", title: "New Session" }])
    expect(navs).toEqual([
      {
        path: `/${base64Encode("/workspace/feature")}/session`,
        reason: "workspace-select:new-session",
        details: {
          projectId: "p1",
          workspaceDir: "/workspace/feature",
          tabId: "tab-new",
        },
      },
    ])
  })

  test("reuses an existing non-process workspace tab", () => {
    const { props, adds, acts, navs, nav } = makeProps()
    props.claxedo.groupTabs = () => ({
      orderedItems: () => [
        {
          id: "tab-process",
          type: "process",
          directory: "/workspace/feature",
          title: "Processes",
          pinned: true,
          closable: false,
        },
        {
          id: "tab-session",
          type: "session",
          directory: "/workspace/feature",
          sessionId: "ses-1",
          title: "Session",
          closable: true,
        },
      ],
      setActive: (id: string) => acts.push(id),
      addSession: (directory: string, sessionId: string, title: string) => {
        adds.push({ directory, sessionId, title })
        return "tab-new"
      },
    })

    createWorkspaceActions(props, nav).handleWorkspaceSelect(
      { id: "p1", worktree: "/workspace/main", sandboxes: ["/workspace/feature"] } as any,
      "/workspace/feature",
    )

    expect(acts).toEqual(["tab-session"])
    expect(adds).toEqual([])
    expect(navs).toEqual([
      {
        path: `/${base64Encode("/workspace/feature")}/session/ses-1`,
        reason: "workspace-select:existing-session",
        details: {
          projectId: "p1",
          workspaceDir: "/workspace/feature",
          tabId: "tab-session",
          sessionId: "ses-1",
        },
      },
    ])
  })

  test("shows recovery dialog instead of creating a draft for a missing local workspace", () => {
    const { props, adds, acts, navs, shows, nav } = makeProps()
    props.projects = () => [{
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
    }]

    createWorkspaceActions(props, nav).handleWorkspaceSelect(
      { id: "p1", worktree: "/workspace/main", sandboxes: ["/workspace/feature"] } as any,
      "/workspace/feature",
    )

    expect(shows).toHaveLength(1)
    expect(acts).toEqual([])
    expect(adds).toEqual([])
    expect(navs).toEqual([])
  })
})
