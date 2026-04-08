import { describe, expect, test } from "bun:test"
import { createSessionActions } from "./session-actions"

function makeProps() {
  const adds: Array<{ directory: string; sessionId: string; title: string }> = []
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
      globalSync: {
        child: (_dir: string) => [{ session: [] }],
      },
      claxedo: {
        split: {
          groups: () => [{ id: "g1" }],
          focusedId: () => "g1",
        },
        groupTabs: (_gid: string) => ({
          addSession: (directory: string, sessionId: string, title: string) => {
            adds.push({ directory, sessionId, title })
            return "tab-new"
          },
          setActive: (_id: string) => undefined,
        }),
        topTabs: {
          addSession: (directory: string, sessionId: string, title: string) => {
            adds.push({ directory, sessionId, title })
            return "tab-new"
          },
          setActive: (_id: string) => undefined,
          findSession: () => undefined,
          close: () => undefined,
        },
        dispatch: () => undefined,
      },
    } as any,
    shows,
    adds,
  }
}

describe("createSessionActions recovery", () => {
  test("shows recovery dialog for missing local workspaces", () => {
    const { props, shows, adds } = makeProps()
    const nav = (_path: string, _reason: string) => undefined

    createSessionActions(props, nav).handleNewSession("/workspace/feature")

    expect(shows).toHaveLength(1)
    expect(adds).toEqual([])
  })
})
