import { Show, onCleanup, type Accessor, type JSX } from "solid-js"

import type { SwitcherItem } from "../compact-switcher/switcher-items"
import type { useClaxedoState } from "../state/index"
import type {
  WorkspacePanelNavigator,
  WorkspacePanelPaneTarget,
} from "../../../features/workspaces/ui/panel/workspace-panel-state"
import { RailWorkbenchCanvas } from "./rail-workbench-canvas"
import { RailWorkspacePanelShell } from "./rail-workspace-panel-shell"
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
  onCloseSurface: (contentId: string) => void
  onDiagnostics?: () => void
  onNewPage?: () => void
  onNewProject?: () => void
  onNewSession: () => void
  onNewTerminalDraft: () => void
  onNewTask: () => void
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

export function RailWorkbenchShell(props: RailWorkbenchShellProps) {
  onCleanup(() => props.onWorkspacePanelWorkbenchColumnRef(undefined))

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
        ref={props.onWorkspacePanelWorkbenchColumnRef}
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
            onNewPage={() => props.onNewPage?.()}
            onNewSession={props.onNewSession}
            onNewTerminalDraft={props.onNewTerminalDraft}
            onNewTask={props.onNewTask}
            onSettings={props.onSettings}
            onSelectSurface={props.onSelectSurface}
            onShowSidebar={props.onShowSidebar}
            onSidebarHotZoneEnter={props.onSidebarHotZoneEnter}
            onToggleWorkspacePanel={props.onToggleWorkspacePanel}
            onToggleWorkspacePanelFullWidth={props.onToggleWorkspacePanelFullWidth}
            sidebarPinned={props.sidebarPinned}
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
          onDiagnostics={props.onDiagnostics}
          onNewProject={props.onNewProject}
        />
      </div>
      <Show when={props.mountWorkspacePanel !== false && props.workspacePanelMounted()}>
        <RailWorkspacePanelShell
          state={props.state}
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
