import { render, screen } from "@solidjs/testing-library"
import { createComponent } from "solid-js"
import { afterEach, describe, expect, test } from "vitest"
import { ClaxedoStateProvider } from "../state/index"
import { emptyClaxedoState } from "../state/persistence"
import { SessionTitleProjectionProvider } from "@/features/session/providers/session-title-projection-provider"
import { setReviewWorkspaceActiveTab } from "@/features/review/ui/review-workspace-active-tab"
import { WorkspacePanelChrome, WorkbenchShellHeader, WorkspacePanelHeader } from "./workbench-shell-header"

describe("WorkspacePanelChrome", () => {
  const base = {
    workspacePanelOpen: () => false,
    workspacePanelFullWidth: () => false,
    allowFullWidth: false,
    onToggleFullWidth: () => {},
    onTogglePanel: () => {},
  }

  test("keeps the workspace toggle neutral while context is presented in the active surface", () => {
    render(() => createComponent(WorkspacePanelChrome, base))

    const toggle = screen.getByRole("button", { name: "Open workspace panel" })
    expect(toggle).toHaveAttribute("data-icon-interaction", "binary")
    expect(toggle).toHaveAttribute("aria-pressed", "false")
    expect(toggle.querySelector('[data-icon="layout-right-partial"]')).toBeTruthy()
    expect(screen.queryByTestId("workspace-panel-toggle-attention")).toBeNull()
  })

  test("uses the selected right-panel glyph while the workspace panel is open", () => {
    render(() => createComponent(WorkspacePanelChrome, { ...base, workspacePanelOpen: () => true }))

    const toggle = screen.getByRole("button", { name: "Close workspace panel" })
    expect(toggle).toHaveAttribute("data-icon-interaction", "binary")
    expect(toggle).toHaveAttribute("aria-pressed", "true")
    expect(toggle.querySelector('[data-icon="layout-right-full"]')).toBeTruthy()
  })

  test("treats workspace width as a dim-off and bright-on binary state", () => {
    const view = render(() =>
      createComponent(WorkspacePanelChrome, {
        ...base,
        allowFullWidth: true,
        workspacePanelOpen: () => true,
      }),
    )

    const maximize = screen.getByRole("button", { name: "Maximize workspace panel" })
    expect(maximize).toHaveAttribute("data-icon-interaction", "binary")
    expect(maximize).toHaveAttribute("aria-pressed", "false")
    expect(maximize.querySelector('[data-icon="expand"]')).toBeTruthy()

    view.unmount()
    render(() =>
      createComponent(WorkspacePanelChrome, {
        ...base,
        allowFullWidth: true,
        workspacePanelOpen: () => true,
        workspacePanelFullWidth: () => true,
      }),
    )

    const restore = screen.getByRole("button", { name: "Restore workspace panel width" })
    expect(restore).toHaveAttribute("data-icon-interaction", "binary")
    expect(restore).toHaveAttribute("aria-pressed", "true")
    expect(restore.querySelector('[data-icon="collapse"]')).toBeTruthy()
  })
})

function headerProps(overrides: Partial<Parameters<typeof WorkbenchShellHeader>[0]> = {}): Parameters<typeof WorkbenchShellHeader>[0] {
  return {
    activeGlobal: () => false,
    canCreateTerminal: () => true,
    focusedPanelTarget: () => undefined,
    hasWorkspacePanelTarget: () => true,
    onCloseSurface: () => {},
    onNewSession: () => {},
    onNewTerminalDraft: () => {},
    onShowSidebar: () => {},
    onSidebarHotZoneEnter: () => {},
    onSelectSurface: () => {},
    onToggleWorkspacePanel: () => {},
    onToggleWorkspacePanelFullWidth: () => {},
    sidebarPinned: () => true,
    surfaceShortcutHints: () => [],
    switcherItems: () => [],
    toggleFocusedWorkspaceNavigator: () => {},
    trafficLightPad: () => false,
    workspacePanelBridgeChromeVisible: () => false,
    workspacePanelForFocusedTarget: () => false,
    workspacePanelFullWidth: () => false,
    workspacePanelNavigator: () => undefined,
    workspacePanelVisualOpen: () => false,
    onFloatingChromeRef: () => {},
    ...overrides,
  }
}

describe("WorkbenchShellHeader", () => {
  test("keeps the workspace panel toggle on a workspace surface", () => {
    render(() => createComponent(WorkbenchShellHeader, headerProps()))
    expect(screen.getByRole("button", { name: "Open workspace panel" })).toBeTruthy()
  })

  test("hides the workspace panel toggle on Marketplace and other global surfaces", () => {
    render(() => createComponent(WorkbenchShellHeader, headerProps({ activeGlobal: () => true })))
    expect(screen.queryByRole("button", { name: "Open workspace panel" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Close workspace panel" })).toBeNull()
    expect(screen.getByTestId("workbench-shell-header").className).toContain("pr-1")
    expect(screen.getByTestId("workbench-shell-header").className).not.toContain("pr-10")
  })
})

describe("WorkspacePanelHeader", () => {
  test("shows the restore control in the L1 header while the panel is at full view", () => {
    render(() => (
      <SessionTitleProjectionProvider>
        <ClaxedoStateProvider initialState={emptyClaxedoState()}>
          <WorkspacePanelHeader
            focusedPanelTarget={() => ({ workspaceDir: "/repo", targetPaneId: "pane-1" })}
            hasWorkspacePanelTarget={() => true}
            workspacePanelForFocusedTarget={() => true}
            workspacePanelNavigator={() => "changes"}
            workspacePanelMode={() => "review"}
            toggleFocusedWorkspaceNavigator={() => {}}
            workspacePanelOpen={() => true}
            workspacePanelFullWidth={() => true}
            onToggleFullWidth={() => {}}
            onTogglePanel={() => {}}
          />
        </ClaxedoStateProvider>
      </SessionTitleProjectionProvider>
    ))

    const restore = screen.getByRole("button", { name: "Restore workspace panel width" })
    expect(restore).toHaveAttribute("aria-pressed", "true")
    expect(restore.querySelector('[data-icon="collapse"]')).toBeTruthy()
  })
})

describe("L2 header strip, per workspace tab kind", () => {
  function renderStrip() {
    return render(() => (
      <SessionTitleProjectionProvider>
        <ClaxedoStateProvider initialState={emptyClaxedoState()}>
          <WorkspacePanelHeader
            focusedPanelTarget={() => ({ workspaceDir: "/repo", targetPaneId: "pane-1" })}
            hasWorkspacePanelTarget={() => true}
            workspacePanelForFocusedTarget={() => true}
            workspacePanelNavigator={() => null}
            workspacePanelMode={() => "review"}
            toggleFocusedWorkspaceNavigator={() => {}}
            workspacePanelOpen={() => true}
            workspacePanelFullWidth={() => false}
            onToggleFullWidth={() => {}}
            onTogglePanel={() => {}}
          />
        </ClaxedoStateProvider>
      </SessionTitleProjectionProvider>
    ))
  }

  function label(container: HTMLElement, kind: string) {
    const strip = container.querySelector(`[data-l2-context="${kind}"]`)
    expect(strip, `L2 strip for ${kind}`).toBeTruthy()
    return strip!.querySelector("span")!
  }

  afterEach(() => setReviewWorkspaceActiveTab(undefined))

  test("a context tab's label truncates in the weak tone, as every non-subagent kind does", () => {
    setReviewWorkspaceActiveTab({ kind: "context", label: "Context" })
    const { container } = renderStrip()

    expect(label(container, "context").className).toContain("truncate")
    expect(label(container, "context").className).toContain("text-text-weak")
    expect(label(container, "context").className).not.toContain("shrink-0")
  })

  test("a subagent's name holds its width so the summary beside it is what truncates", () => {
    setReviewWorkspaceActiveTab({ kind: "subagent", label: "explorer", description: "Find every caller" })
    const { container } = renderStrip()

    const name = label(container, "subagent")
    expect(name.textContent).toBe("explorer")
    expect(name.className).toContain("shrink-0")
    expect(name.className).toContain("text-text-base")
    expect(name.className).not.toContain("truncate")

    const summary = container.querySelector('[data-l2-context="subagent"] span + span')!
    expect(summary.textContent).toBe("Find every caller")
    expect(summary.className).toContain("truncate")
  })
})
