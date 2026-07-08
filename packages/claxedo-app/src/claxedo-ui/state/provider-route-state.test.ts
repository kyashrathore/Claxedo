import { describe, expect, test } from "bun:test"
import { constructWorkbenchState } from "../layout"
import { createWorkspacePanel } from "../workspace-panel/workspace-panel-state"
import { initialStateForPath, routeOwnsInitialSurface } from "./provider"
import { emptyClaxedoState } from "./persistence"
import type { ClaxedoState } from "./types"

function persistedState(): ClaxedoState {
  return {
    ...emptyClaxedoState(),
    workbench: {
      ...constructWorkbenchState.empty(),
      panes: [{ id: "pane-1", contentId: "session-1" }],
      contentIds: ["session-1"],
      contentRecency: ["session-1"],
      focusedPaneId: "pane-1",
    },
    meta: {
      "session-1": {
        id: "session-1",
        type: "session",
        directory: "/repo/main",
        sessionId: "ses_old",
        content: {
          type: "session",
          directory: "/repo/main",
          sessionId: "ses_old",
        },
      },
    },
    terminal: {
      owner: { pty_1: "session-1" },
      agentStatus: {},
      agentSeen: {},
      lifecycle: {},
    },
    workspacePanel: createWorkspacePanel({ mode: "review", target: { workspaceDir: "/repo/main" } }),
  }
}

describe("route-owned initial state", () => {
  test("direct session routes start with an empty surface graph", () => {
    const state = initialStateForPath(persistedState(), "/s/ses_new")

    expect(state.workbench.contentIds).toEqual([])
    expect(state.workbench.panes).toEqual([])
    expect(state.meta).toEqual({})
    expect(state.terminal.owner).toEqual({})
    expect(state.workspacePanel.open).toBe(false)
  })

  test("home keeps the persisted workbench", () => {
    const original = persistedState()

    expect(initialStateForPath(original, "/")).toBe(original)
  })

  test("route ownership covers explicit surface routes only", () => {
    expect(routeOwnsInitialSurface("/s/ses_1")).toBe(true)
    expect(routeOwnsInitialSurface("/w/ws_1/session")).toBe(true)
    expect(routeOwnsInitialSurface("/w/ws_1/page/page_1")).toBe(true)
    expect(routeOwnsInitialSurface("/w/ws_1")).toBe(false)
    expect(routeOwnsInitialSurface("/")).toBe(false)
  })
})
