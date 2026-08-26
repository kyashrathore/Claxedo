import { onCleanup, type Accessor } from "solid-js"

import { WorkspacePanel } from "../../../features/workspaces/ui/panel/workspace-panel"
import {
  isGlobalPanelMode,
  type WorkspacePanelMode,
  type WorkspacePanelNavigator,
  type WorkspacePanelPaneTarget,
} from "../../../features/workspaces/ui/panel/workspace-panel-state"
import { setWorkGraphPanelBodySlot, setWorkGraphPanelHeaderSlot } from "@/ui/controls/portal-slot"
import type { useClaxedoState } from "../state/index"
import { WorkspacePanelChrome, WorkspacePanelHeader } from "./workbench-shell-header"
import { WorkspacePanelBody } from "./workspace-panel-body"

type RailWorkspacePanelState = ReturnType<typeof useClaxedoState>

// Compact resting width for the global WorkGraph panel — a "Needs you" / Settings
// list does not need the 70% review default. The user can still drag to resize.
const WORKGRAPH_PANEL_WIDTH = 420

export function RailWorkspacePanelShell(props: {
  state: RailWorkspacePanelState
  focusedPanelTarget: () => WorkspacePanelPaneTarget | undefined
  hasWorkspacePanelTarget: () => boolean
  onPanelShellRef: (element: HTMLElement | undefined) => void
  onRestingWidthChange: (width: number) => void
  onToggleWorkspacePanelFullWidth: () => void
  toggleFocusedWorkspaceNavigator: (navigator: WorkspacePanelNavigator) => void
  toggleFocusedWorkspaceReview: (button: HTMLButtonElement) => void
  visualOpen: Accessor<boolean>
  workspacePanelForFocusedTarget: () => boolean
  workspacePanelFullWidth: Accessor<boolean>
  workspacePanelMode: () => string | undefined
  workspacePanelNavigator: () => WorkspacePanelNavigator | null | undefined
}) {
  const globalMode = () => isGlobalPanelMode(props.state.workspacePanel.state().mode as WorkspacePanelMode | undefined)
  return (
    <WorkspacePanel
      state={props.state.workspacePanel.state()}
      visualOpen={props.visualOpen}
      fullWidth={props.workspacePanelFullWidth}
      preferredWidth={() => (globalMode() ? WORKGRAPH_PANEL_WIDTH : undefined)}
      onRestingWidthChange={props.onRestingWidthChange}
      onShellRef={props.onPanelShellRef}
      onModeSelect={(mode) => props.state.workspacePanel.select(mode)}
      contentIdentity={(state) => ({
        family: isGlobalPanelMode(state.mode) ? "global" : "workspace",
        activitySubject: state.activitySubject,
        workspaceDir: state.workspaceDir,
      })}
      onClose={() => {
        props.state.workspacePanel.close()
      }}
      renderHeader={(state) =>
        isGlobalPanelMode(state.mode) ? (
          <GlobalPanelHeader
            workspacePanelOpen={props.visualOpen}
            workspacePanelFullWidth={props.workspacePanelFullWidth}
            onToggleFullWidth={props.onToggleWorkspacePanelFullWidth}
            onTogglePanel={props.toggleFocusedWorkspaceReview}
          />
        ) : (
          <WorkspacePanelHeader
            focusedPanelTarget={props.focusedPanelTarget}
            hasWorkspacePanelTarget={props.hasWorkspacePanelTarget}
            workspacePanelForFocusedTarget={props.workspacePanelForFocusedTarget}
            workspacePanelNavigator={props.workspacePanelNavigator}
            workspacePanelMode={props.workspacePanelMode}
            toggleFocusedWorkspaceNavigator={props.toggleFocusedWorkspaceNavigator}
            workspacePanelOpen={props.visualOpen}
            workspacePanelFullWidth={props.workspacePanelFullWidth}
            onToggleFullWidth={props.onToggleWorkspacePanelFullWidth}
            onTogglePanel={props.toggleFocusedWorkspaceReview}
          />
        )
      }
      renderMode={(mode, state, active) =>
        isGlobalPanelMode(mode) ? <GlobalPanelBodyMount /> : <WorkspacePanelBody mode={mode} state={state} active={active} />
      }
    />
  )
}

/**
 * Header for a global-navigation panel mode. Reuses the exact top-level
 * `WorkspacePanelChrome` toggle so there is one physical toggle, and exposes a
 * header portal slot the active global surface fills with its tab controls.
 */
function GlobalPanelHeader(props: {
  workspacePanelOpen: () => boolean
  workspacePanelFullWidth: () => boolean
  onToggleFullWidth: () => void
  onTogglePanel: (button: HTMLButtonElement) => void
}) {
  onCleanup(() => setWorkGraphPanelHeaderSlot(null))
  return (
    <div class="shrink-0 bg-background-base">
      <div
        data-testid="workgraph-panel-l1-header"
        class="relative flex h-9 shrink-0 items-center gap-2 overflow-hidden border-b border-border-weaker-base bg-background-base pl-2"
      >
        <div
          ref={(el) => setWorkGraphPanelHeaderSlot(el)}
          data-testid="workgraph-panel-header-slot"
          class="flex h-full min-w-0 flex-1 items-center overflow-hidden"
        />
        <div class="flex h-full shrink-0 items-center pr-1">
          <WorkspacePanelChrome
            workspacePanelOpen={props.workspacePanelOpen}
            workspacePanelFullWidth={props.workspacePanelFullWidth}
            onToggleFullWidth={props.onToggleFullWidth}
            onTogglePanel={props.onTogglePanel}
          />
        </div>
      </div>
    </div>
  )
}

function GlobalPanelBodyMount() {
  onCleanup(() => setWorkGraphPanelBodySlot(null))
  return (
    <div
      ref={(el) => setWorkGraphPanelBodySlot(el)}
      data-testid="workgraph-panel-body-slot"
      class="flex size-full min-h-0 flex-col"
    />
  )
}
