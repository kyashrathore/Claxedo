import { describe, expect, test } from "bun:test"
import { createTerminalActions } from "./terminal-actions"

function makeProps() {
  const adds: Array<{ directory: string; terminalId: string; title: string }> = []
  const shows: unknown[] = []

  return {
    props: {
      flowLog: () => undefined,
      params: {},
      activeWorkspaceId: () => "/workspace/feature",
      activeProjectId: () => "p1",
      projects: () => [{
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
      }],
      navigate: (_path: string) => undefined,
      dialog: {
        show: (view: unknown) => shows.push(view),
      },
      globalSDK: {},
      layout: {},
      platform: {},
      config: {},
      globalSync: {},
      claxedo: {
        split: {
          focusedId: () => "g1",
        },
        groupTabs: (_gid: string) => ({
          addTerminal: (directory: string, terminalId: string, title: string) => {
            adds.push({ directory, terminalId, title })
            return "tab-new"
          },
        }),
        topTabs: {
          addTerminal: (directory: string, terminalId: string, title: string) => {
            adds.push({ directory, terminalId, title })
            return "tab-new"
          },
        },
        dispatch: () => undefined,
        terminal: {
          pendingCreate: () => false,
          creating: () => false,
          creatingGroupId: () => undefined,
          queueCreateForTab: () => undefined,
        },
      },
    } as any,
    shows,
    adds,
  }
}

describe("createTerminalActions recovery", () => {
  test("shows recovery dialog for missing local workspaces", () => {
    const { props, shows, adds } = makeProps()

    createTerminalActions(props).handleNewTerminal("/workspace/feature")

    expect(shows).toHaveLength(1)
    expect(adds).toEqual([])
  })
})
