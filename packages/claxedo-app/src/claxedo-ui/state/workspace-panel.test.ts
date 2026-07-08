import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { emptyClaxedoState } from "./persistence"
import { createWorkspacePanelSlice } from "./workspace-panel"
import type { ClaxedoState } from "./types"

function makeSlice() {
  const [state, setState] = createStore<ClaxedoState>(emptyClaxedoState())
  const workspacePanel = createWorkspacePanelSlice({
    state,
    setState,
    defaultTarget: () => ({ workspaceDir: "/default", targetPaneId: "pane-default" }),
  })
  return { state, workspacePanel }
}

describe("workspace panel slice", () => {
  test("restores open mode and navigator per session while retargeting the active pane", () => {
    const { state, workspacePanel } = makeSlice()

    workspacePanel.open("review", {
      workspaceDir: "/repo",
      targetPaneId: "pane-a",
      navigator: "changes",
    })
    workspacePanel.rememberSession("ses_a")

    workspacePanel.open("processes", {
      workspaceDir: "/repo",
      targetPaneId: "pane-b",
      navigator: "processes",
    })
    workspacePanel.close()
    workspacePanel.rememberSession("ses_b")

    expect(workspacePanel.restoreSession("ses_a", {
      workspaceDir: "/repo",
      targetPaneId: "pane-current",
    })).toBe(true)
    expect(state.workspacePanel).toMatchObject({
      open: true,
      mode: "review",
      navigator: "changes",
      workspaceDir: "/repo",
      targetPaneId: "pane-current",
    })

    expect(workspacePanel.restoreSession("ses_b", {
      workspaceDir: "/repo",
      targetPaneId: "pane-current",
    })).toBe(true)
    expect(state.workspacePanel).toMatchObject({
      open: false,
      mode: "processes",
      navigator: "processes",
      workspaceDir: "/repo",
      targetPaneId: "pane-current",
    })
  })
})
