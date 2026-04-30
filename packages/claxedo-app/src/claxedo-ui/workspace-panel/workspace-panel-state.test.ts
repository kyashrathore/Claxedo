import { describe, expect, test } from "bun:test"
import {
  closeWorkspacePanel,
  createWorkspacePanel,
  openWorkspacePanel,
  retargetWorkspacePanel,
} from "./workspace-panel-state"

describe("workspace panel state", () => {
  test("opens workspace tools against the current workspace and pane", () => {
    const state = openWorkspacePanel(createWorkspacePanel(), {
      mode: "files",
      workspaceDir: "/workspace",
      targetPaneId: "pane-session",
    })

    expect(state).toEqual({
      open: true,
      mode: "files",
      workspaceDir: "/workspace",
      targetPaneId: "pane-session",
      navigator: undefined,
      focus: undefined,
      tabs: [{ id: "review", type: "review" }],
      activeTabId: "review",
    })
  })

  test("retargets without changing the selected tool", () => {
    const state = retargetWorkspacePanel(
      openWorkspacePanel(createWorkspacePanel(), {
        mode: "review",
        workspaceDir: "/workspace-a",
        targetPaneId: "pane-a",
      }),
      {
        workspaceDir: "/workspace-b",
        targetPaneId: "pane-b",
      },
    )

    expect(state).toEqual({
      open: true,
      mode: "review",
      workspaceDir: "/workspace-b",
      targetPaneId: "pane-b",
      navigator: undefined,
      focus: undefined,
      tabs: [{ id: "review", type: "review" }],
      activeTabId: "review",
    })
  })

  test("tracks navigator and focus requests with incrementing versions", () => {
    const opened = openWorkspacePanel(createWorkspacePanel(), {
      mode: "review",
      workspaceDir: "/workspace",
      targetPaneId: "pane-session",
      navigator: "processes",
      focus: { kind: "process", processId: "proc-dev" },
    })
    const retargeted = retargetWorkspacePanel(opened, {
      workspaceDir: "/workspace",
      targetPaneId: "pane-session",
      focus: { kind: "process", processId: "proc-dev" },
    })

    expect(opened.navigator).toBe("processes")
    expect(opened.focus).toEqual({ kind: "process", processId: "proc-dev", version: 1 })
    expect(retargeted.focus).toEqual({ kind: "process", processId: "proc-dev", version: 2 })
  })

  test("clears navigator and focus when requested", () => {
    const state = retargetWorkspacePanel(
      openWorkspacePanel(createWorkspacePanel(), {
        mode: "review",
        workspaceDir: "/workspace",
        targetPaneId: "pane-session",
        navigator: "files",
        focus: { kind: "file", path: "src/app.ts", intent: "tab" },
      }),
      {
        workspaceDir: "/workspace",
        targetPaneId: "pane-session",
        navigator: null,
        focus: null,
      },
    )

    expect(state.navigator).toBeUndefined()
    expect(state.focus).toBeUndefined()
  })

  test("closing preserves the contextual target for quick reopen", () => {
    const state = closeWorkspacePanel(
      openWorkspacePanel(createWorkspacePanel(), {
        mode: "processes",
        workspaceDir: "/workspace",
        targetPaneId: "pane-terminal",
      }),
    )

    expect(state).toEqual({
      open: false,
      mode: "processes",
      workspaceDir: "/workspace",
      targetPaneId: "pane-terminal",
      navigator: undefined,
      focus: undefined,
      tabs: [{ id: "review", type: "review" }],
      activeTabId: "review",
    })
  })
})
