import { Show, onCleanup, type Accessor, type JSX } from "solid-js"

import type { SwitcherItem } from "../compact-switcher/switcher-items"
import type { useClaxedoState } from "../state/index"
import type {
  WorkspacePanelNavigator,
  WorkspacePanelPaneTarget,
} from "../../../features/workspaces/ui/panel/workspace-panel-state"
import { RailWorkbenchCanvas } from "./rail-workbench-canvas"
import { RailWorkspacePanelShell } from "./rail-workspace-panel-shell"
import { warmWorkspacePanelReviewWhenIdle } from "./workspace-panel-review-load"
import { warmIconSpritesWhenIdle } from "@opencode-ai/ui/icon-sprite-warm"
import { WorkbenchShellHeader } from "./workbench-shell-header"

type RailWorkbenchShellState = ReturnType<typeof useClaxedoState>

export type RailWorkbenchShellProps = {
  activeGlobal: Accessor<boolean>
  canUseDocuments?: boolean
  canCreateTerminal: Accessor<boolean>
  children?: JSX.Element
  emptyDraftDirectory: Accessor<string | undefined>
  focusedPanelTarget: () => WorkspacePanelPaneTarget | undefined
  hasWorkspacePanelTarget: () => boolean
  onCloseFocusedPane: (paneId: string, contentId: string | null) => void
  onCloseSurface: (contentId: string) => void
  onDiagnostics?: () => void
  onNewPage?: () => void
  onNewProject?: () => void
  onNewSession: () => void
  onNewTerminalDraft: () => void
  onWorkspacePanelFloatingChromeRef: (element: HTMLElement | undefined) => void
  onWorkspacePanelShellRef: (element: HTMLElement | undefined) => void
  onWorkspacePanelWorkbenchColumnRef: (element: HTMLElement | undefined) => void
  onWorkspacePanelWidthChange: (width: number) => void
  onSelectSurface: (contentId: string) => void
  onSettings?: () => void
  onShowSidebar: () => void
  onSidebarHotZoneEnter: () => void
  onToggleWorkspacePanel: (button: HTMLButtonElement) => void
  onToggleWorkspacePanelFullWidth: () => void
  projectsCount: Accessor<number>
  sidebarPinned: Accessor<boolean>
  state: RailWorkbenchShellState
  surfaceShortcutHints: Accessor<readonly string[]>
  switcherItems: Accessor<SwitcherItem[]>
  toggleFocusedWorkspaceNavigator: (navigator: WorkspacePanelNavigator) => void
  toggleFocusedWorkspaceReview: (button: HTMLButtonElement) => void
  topBarRight?: () => JSX.Element
  trafficLightPad: Accessor<boolean>
  workspacePanelBridgeChromeVisible: Accessor<boolean>
  workspacePanelForFocusedTarget: () => boolean
  workspacePanelFullWidth: Accessor<boolean>
  workspacePanelMode: () => string | undefined
  workspacePanelMounted: Accessor<boolean>
  workspacePanelNavigator: () => WorkspacePanelNavigator | null | undefined
  workspacePanelVisualOpen: Accessor<boolean>
  workspacePanelWidth: Accessor<number>
  mountWorkspacePanel?: boolean
}

/**
 * The property the workbench column below animates when the panel opens. It is
 * the panel's real opening motion — the shell that slides in is created by the
 * opening click and so never transitions its own transform — which is why the
 * panel's settle gate is handed this pair rather than left to guess.
 */
const WORKBENCH_COLUMN_MOTION_PROPERTY = "margin-right"

export function RailWorkbenchShell(props: RailWorkbenchShellProps) {
  onCleanup(() => props.onWorkspacePanelWorkbenchColumnRef(undefined))
  // Plain field, not a signal: the column outlives every panel open, and the
  // settle gate reads it while arming inside the click task. Making it
  // reactive would only let a ref registration re-arm the gate.
  let workbenchColumn: HTMLElement | undefined
  // The workspace panel's shell is mounted BY THE OPENING CLICK (the `Show` on
  // `workspacePanelMounted()` below, whose signal starts closed), so the panel
  // shell itself is far too late to warm its own body. This workbench shell is
  // the panel's mount owner and lives for the whole session, which makes it the
  // earliest place that honestly knows the body's modules will be wanted.
  if (props.mountWorkspacePanel !== false) onCleanup(warmWorkspacePanelReviewWhenIdle())
  onCleanup(warmIconSpritesWhenIdle())

  return (
    // `role="main"` makes this pane column the page's single `main` landmark
    // (axe `landmark-one-main`/`region`): the app shell renders the sidebar and
    // this workbench as sibling <div>s with no landmark roles, so nothing was
    // exposed as the primary content region until here. Paired with the
    // `role="navigation"` wrapper the shell puts around the sidebar.
    <div
      role="main"
      class="relative flex flex-1 min-w-0 min-h-0 overflow-hidden bg-background-stronger md:rounded-tl-[12px] transition-[background-color,border-color] duration-200 ease-out"
    >
      <div
        ref={(element) => {
          workbenchColumn = element
          props.onWorkspacePanelWorkbenchColumnRef(element)
        }}
        data-testid="workbench-column"
        class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden transition-[margin-right] duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] will-change-[margin-right]"
        style={{
          "margin-right": props.workspacePanelVisualOpen() ? `${props.workspacePanelWidth()}px` : "0px",
        }}
      >
        <Show when={props.projectsCount() > 0}>
          <WorkbenchShellHeader
            activeGlobal={props.activeGlobal}
            canCreateTerminal={props.canCreateTerminal}
            canUseDocuments={props.canUseDocuments}
            focusedPanelTarget={props.focusedPanelTarget}
            hasWorkspacePanelTarget={props.hasWorkspacePanelTarget}
            onCloseSurface={props.onCloseSurface}
            onFloatingChromeRef={props.onWorkspacePanelFloatingChromeRef}
            onNewPage={props.onNewPage}
            onNewSession={props.onNewSession}
            onNewTerminalDraft={props.onNewTerminalDraft}
            onSettings={props.onSettings}
            onSelectSurface={props.onSelectSurface}
            onShowSidebar={props.onShowSidebar}
            onSidebarHotZoneEnter={props.onSidebarHotZoneEnter}
            onToggleWorkspacePanel={props.onToggleWorkspacePanel}
            onToggleWorkspacePanelFullWidth={props.onToggleWorkspacePanelFullWidth}
            sidebarPinned={props.sidebarPinned}
            surfaceShortcutHints={props.surfaceShortcutHints}
            switcherItems={props.switcherItems}
            toggleFocusedWorkspaceNavigator={props.toggleFocusedWorkspaceNavigator}
            topBarRight={props.topBarRight}
            trafficLightPad={props.trafficLightPad}
            workspacePanelBridgeChromeVisible={props.workspacePanelBridgeChromeVisible}
            workspacePanelForFocusedTarget={props.workspacePanelForFocusedTarget}
            workspacePanelFullWidth={props.workspacePanelFullWidth}
            workspacePanelNavigator={props.workspacePanelNavigator}
            workspacePanelVisualOpen={props.workspacePanelVisualOpen}
          />
        </Show>
        <RailWorkbenchCanvas
          state={props.state}
          emptyDraftDirectory={props.emptyDraftDirectory}
          onCloseFocusedPane={props.onCloseFocusedPane}
          onDiagnostics={props.onDiagnostics}
          onNewProject={props.onNewProject}
        />
      </div>
      <Show when={props.mountWorkspacePanel !== false && props.workspacePanelMounted()}>
        <RailWorkspacePanelShell
          state={props.state}
          openMotion={() => ({ element: workbenchColumn, property: WORKBENCH_COLUMN_MOTION_PROPERTY })}
          focusedPanelTarget={props.focusedPanelTarget}
          hasWorkspacePanelTarget={props.hasWorkspacePanelTarget}
          toggleFocusedWorkspaceNavigator={props.toggleFocusedWorkspaceNavigator}
          toggleFocusedWorkspaceReview={props.toggleFocusedWorkspaceReview}
          onRestingWidthChange={props.onWorkspacePanelWidthChange}
          onPanelShellRef={props.onWorkspacePanelShellRef}
          onToggleWorkspacePanelFullWidth={props.onToggleWorkspacePanelFullWidth}
          visualOpen={props.workspacePanelVisualOpen}
          workspacePanelForFocusedTarget={props.workspacePanelForFocusedTarget}
          workspacePanelFullWidth={props.workspacePanelFullWidth}
          workspacePanelMode={props.workspacePanelMode}
          workspacePanelNavigator={props.workspacePanelNavigator}
        />
      </Show>

      {/* Mount route content (DirectoryLayout + providers) without rendering it visually. */}
      <div class="hidden">{props.children}</div>
    </div>
  )
}
