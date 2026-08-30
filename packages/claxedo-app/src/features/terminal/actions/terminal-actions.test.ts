import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { configureAppPortsForTest } from "@/app/integrations/test-support/app-ports-stub"
import { workspaceTerminalRoute } from "@/platform/identity/route"

let createTerminalActions: typeof import("./terminal-actions").createTerminalActions

beforeEach(() => {
  configureAppPortsForTest({
    terminal: {
      recoverMissingWorkspace: () => false,
    },
  })
})

beforeAll(async () => {
  createTerminalActions = (await import("./terminal-actions")).createTerminalActions
})

function makeProps(focusedMeta: Record<string, unknown> = {
  type: "session",
  sessionId: "session-1",
  directory: "/workspace/shared",
  content: { type: "session", sessionId: "session-1", workspaceRouteId: "p2" },
}) {
  const opens: Array<{ directory: string; terminalId: string; workspaceRouteId?: string; sessionId?: string }> = []
  const queued: Array<{ contentId: string; directory: string }> = []
  const navs: string[] = []
  const props = {
    flowLog: () => undefined,
    params: {},
    activeDirectory: () => "/workspace/shared",
    workspaceRouteId: () => undefined,
    projects: () => [
      { id: "p1", worktree: "/workspace/shared" },
      { id: "p2", worktree: "/workspace/shared" },
    ],
    state: {
      wb: {
        state: { focusedPaneId: "pane-1" },
        selectors: { focusedContent: () => "session-content" },
        split: { focus: () => undefined },
      },
      meta: { get: () => focusedMeta },
      layout: {
        openTerminal: (directory: string, terminalId: string, _title?: string, opts?: { workspaceRouteId?: string; sessionId?: string }) => {
          opens.push({ directory, terminalId, workspaceRouteId: opts?.workspaceRouteId, sessionId: opts?.sessionId })
          return "terminal-content"
        },
      },
      workspacePanel: { close: () => undefined },
      terminal: {
        queueCreateForContent: (contentId: string, directory: string) => queued.push({ contentId, directory }),
      },
    },
  } as never
  const nav = (path: string) => navs.push(path)
  return { props, opens, queued, navs, nav }
}

describe("createTerminalActions", () => {
  test("uses the selected opaque identity before opening an ambiguous directory", () => {
    const { props, opens, queued, navs, nav } = makeProps()

    createTerminalActions(props, nav).handleNewTerminal(
      "/workspace/shared",
      undefined,
      undefined,
      undefined,
      "p2",
    )

    expect(opens).toHaveLength(1)
    expect(opens[0]?.workspaceRouteId).toBe("p2")
    expect(opens[0]?.sessionId).toBe("session-1")
    expect(queued).toEqual([{ contentId: "terminal-content", directory: "/workspace/shared" }])
    expect(navs).toEqual([workspaceTerminalRoute("p2", opens[0].terminalId)])
  })

  test("does not copy a focused session identity from a different workspace", () => {
    const { props, opens, nav } = makeProps({
      type: "session",
      sessionId: "session-other",
      directory: "/workspace/shared",
      content: { type: "session", sessionId: "session-other", workspaceRouteId: "p1" },
    })

    createTerminalActions(props, nav).handleNewTerminal(
      "/workspace/shared",
      undefined,
      undefined,
      undefined,
      "p2",
    )

    expect(opens).toHaveLength(1)
    expect(opens[0]?.workspaceRouteId).toBe("p2")
    expect(opens[0]?.sessionId).toBeUndefined()
  })

  test("does not open a terminal before a workspace route identity exists", () => {
    const { props, opens, queued, navs, nav } = makeProps()

    createTerminalActions(props, nav).handleNewTerminal("/workspace/shared")

    expect(opens).toEqual([])
    expect(queued).toEqual([])
    expect(navs).toEqual([])
  })

  test("recovery persists the recovered workspace identity before opening", () => {
    configureAppPortsForTest({
      terminal: {
        recoverMissingWorkspace: (_props, _directory, onReady) => {
          void onReady(
            "/workspace/recovered",
            { id: "ws_recovered", worktree: "/workspace/recovered" } as never,
            {} as never,
          )
          return true
        },
      },
    })
    const { props, opens, queued, navs, nav } = makeProps()

    createTerminalActions(props, nav).handleNewTerminal("/workspace/missing", "claude")

    expect(opens).toHaveLength(1)
    expect(opens[0]).toMatchObject({
      directory: "/workspace/recovered",
      workspaceRouteId: "ws_recovered",
    })
    expect(queued).toEqual([{ contentId: "terminal-content", directory: "/workspace/recovered" }])
    expect(navs[0]).toMatch(/^\/w\/ws_recovered\/terminal\/pending-/)
  })
})
