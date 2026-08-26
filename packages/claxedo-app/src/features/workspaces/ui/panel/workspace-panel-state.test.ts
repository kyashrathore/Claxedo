import { describe, expect, test } from "bun:test"
import {
  closeWorkspacePanel,
  createWorkspacePanel,
  openWorkspacePanel,
  retargetWorkspacePanel,
  shouldRetargetWorkspacePanelForFocusedPane,
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
      activitySubject: undefined,
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
      activitySubject: undefined,
    })
  })

  test("follows focused pane changes only when already bound to the old focused pane", () => {
    const state = openWorkspacePanel(createWorkspacePanel(), {
      mode: "review",
      workspaceDir: "/workspace-a",
      targetPaneId: "pane-a",
    })

    expect(
      shouldRetargetWorkspacePanelForFocusedPane(
        state,
        { workspaceDir: "/workspace-a", targetPaneId: "pane-a" },
        { workspaceDir: "/workspace-b", targetPaneId: "pane-b" },
      ),
    ).toBe(true)

    expect(
      shouldRetargetWorkspacePanelForFocusedPane(
        state,
        { workspaceDir: "/workspace-other", targetPaneId: "pane-other" },
        { workspaceDir: "/workspace-b", targetPaneId: "pane-b" },
      ),
    ).toBe(false)
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

  test("carries external image URLs through browser focus", () => {
    const state = openWorkspacePanel(createWorkspacePanel(), {
      workspaceDir: "/workspace",
      targetPaneId: "pane-session",
      navigator: null,
      focus: { kind: "browser", url: "https://cdn.example.com/source.png" },
    })

    expect(state.focus).toEqual({
      kind: "browser",
      url: "https://cdn.example.com/source.png",
      version: 1,
    })
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
      activitySubject: undefined,
    })
  })

  test("reopening the same workspace without explicit clears preserves navigator and focus", () => {
    const closed = closeWorkspacePanel(
      openWorkspacePanel(createWorkspacePanel(), {
        mode: "review",
        workspaceDir: "/workspace",
        targetPaneId: "pane-session",
        navigator: "changes",
        focus: { kind: "file", path: "src/app.ts", intent: "review" },
      }),
    )
    const reopened = openWorkspacePanel(closed, {
      mode: "review",
      workspaceDir: "/workspace",
      targetPaneId: "pane-session",
    })

    expect(reopened.navigator).toBe("changes")
    expect(reopened.focus).toEqual({ kind: "file", path: "src/app.ts", intent: "review", version: 1 })
  })

  test("opens activity against an explicit subject", () => {
    const state = openWorkspacePanel(createWorkspacePanel(), {
      mode: "activity",
      workspaceDir: "/workspace",
      activitySubject: {
        subjectType: "intake_item",
        subjectId: "intake_1",
        label: "Incoming issue",
      },
    })

    expect(state.activitySubject).toEqual({
      subjectType: "intake_item",
      subjectId: "intake_1",
      label: "Incoming issue",
    })
  })

  test("defaults to review mode when opened without a mode", () => {
    const state = openWorkspacePanel(createWorkspacePanel(), {
      workspaceDir: "/workspace",
      targetPaneId: "pane-session",
    })

    expect(state.open).toBe(true)
    expect(state.mode).toBe("review")
  })

  test("a file focus escapes a global mode instead of being silently swallowed", () => {
    const globalState = openWorkspacePanel(createWorkspacePanel(), { mode: "workgraph-attention" })

    const state = openWorkspacePanel(globalState, {
      workspaceDir: "/workspace",
      targetPaneId: "pane-session",
      navigator: "files",
      focus: { kind: "file", path: "src/foo.ts", intent: "tab" },
    })

    // The workspace panel body (which consumes file focus) never mounts under
    // a global mode — keeping workgraph-attention here dropped the click.
    expect(state.mode).toBe("review")
    expect(state.focus).toMatchObject({ kind: "file", path: "src/foo.ts" })
  })

  test("opening without a focus keeps a global mode", () => {
    const globalState = openWorkspacePanel(createWorkspacePanel(), { mode: "workgraph-attention" })
    const state = openWorkspacePanel(globalState, {})
    expect(state.mode).toBe("workgraph-attention")
  })

  test("carries line/col through file focus and bumps version per open", () => {
    const first = openWorkspacePanel(createWorkspacePanel(), {
      workspaceDir: "/workspace",
      targetPaneId: "pane-session",
      focus: { kind: "file", path: "src/foo.ts", intent: "tab", line: 42, col: 7 },
    })
    expect(first.focus).toMatchObject({ kind: "file", path: "src/foo.ts", line: 42, col: 7, version: 1 })

    const second = openWorkspacePanel(first, {
      workspaceDir: "/workspace",
      targetPaneId: "pane-session",
      focus: { kind: "file", path: "src/foo.ts", intent: "tab", line: 42, col: 7 },
    })
    expect(second.focus?.version).toBe(2)
  })
})
