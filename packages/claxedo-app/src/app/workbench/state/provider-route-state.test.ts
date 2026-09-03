import { describe, expect, test } from "bun:test"
import { constructWorkbenchState } from "../workbench/index"
import { createWorkspacePanel } from "../../../features/workspaces/ui/panel/workspace-panel-state"
import { initialStateForPath, routeOwnsInitialSurface, routeSuppressesEmptyDraftSession } from "./provider"
import { emptyClaxedoState } from "./persistence"
import type { ClaxedoState } from "./types"
import { legacyDirectoryRouteKey } from "@/platform/identity/route"

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

  const legacyDirectory = legacyDirectoryRouteKey("/repo/main")
  test.each([
    ["direct session", "/s/ses_1", true],
    ["workspace new session", "/w/ws_1/session", true],
    ["workspace existing session", "/w/ws_1/session/ses_1", true],
    ["workspace page", "/w/ws_1/page/page_1", true],
    ["workspace terminal", "/w/ws_1/terminal/pty_1", true],
    ["legacy session", `/${legacyDirectory}/session/ses_1`, true],
    ["legacy page", `/${legacyDirectory}/page/page_1`, true],
    ["legacy terminal", `/${legacyDirectory}/terminal/pty_1`, true],
    ["home", "/", false],
    ["workspace root", "/w/ws_1", false],
    ["legacy directory root", `/${legacyDirectory}`, false],
    ["marketplace", "/marketplace", false],
    ["unknown root", "/login", false],
  ] as const)("classifies the %s route", (_label, pathname, expected) => {
    expect(routeOwnsInitialSurface(pathname)).toBe(expected)
  })

  test.each([
    ["direct session", "/s/ses_1", true],
    ["workspace root", "/w/ws_1", true],
    ["workspace new session", "/w/ws_1/session", true],
    ["legacy directory root", `/${legacyDirectory}`, true],
    ["legacy new session", `/${legacyDirectory}/session`, true],
    ["marketplace", "/marketplace", true],
    ["home", "/", false],
    ["unknown route", "/login", false],
  ] as const)("%s controls automatic draft creation independently", (_label, pathname, expected) => {
    expect(routeSuppressesEmptyDraftSession(pathname)).toBe(expected)
  })
})
