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

function makeProps() {
  const opens: Array<{ directory: string; terminalId: string }> = []
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
        split: { focus: () => undefined },
      },
      layout: {
        openTerminal: (directory: string, terminalId: string) => {
          opens.push({ directory, terminalId })
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
    expect(queued).toEqual([{ contentId: "terminal-content", directory: "/workspace/shared" }])
    expect(navs).toEqual([workspaceTerminalRoute("p2", opens[0].terminalId)])
  })

  test("does not open a terminal before a workspace route identity exists", () => {
    const { props, opens, queued, navs, nav } = makeProps()

    createTerminalActions(props, nav).handleNewTerminal("/workspace/shared")

    expect(opens).toEqual([])
    expect(queued).toEqual([])
    expect(navs).toEqual([])
  })
})
