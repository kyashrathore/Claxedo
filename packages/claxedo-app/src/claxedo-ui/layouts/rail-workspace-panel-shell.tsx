import type { Accessor } from "solid-js"

import { WorkspacePanel } from "../workspace-panel/WorkspacePanel"
import type {
  WorkspacePanelNavigator,
  WorkspacePanelPaneTarget,
} from "../workspace-panel/workspace-panel-state"
import type { useClaxedoState } from "../state"
import { WorkspacePanelHeader } from "./workbench-shell-header"
import { WorkspacePanelBody } from "./workspace-panel-body"

type RailWorkspacePanelState = ReturnType<typeof useClaxedoState>

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
  return (
    <WorkspacePanel
      state={props.state.workspacePanel.state()}
      visualOpen={props.visualOpen}
      fullWidth={props.workspacePanelFullWidth}
      onRestingWidthChange={props.onRestingWidthChange}
      onShellRef={props.onPanelShellRef}
      onModeSelect={(mode) => props.state.workspacePanel.select(mode)}
      contentIdentity={(state) => ({
        activitySubject: state.activitySubject,
        workspaceDir: state.workspaceDir,
      })}
      onClose={() => {
        props.state.workspacePanel.close()
      }}
      renderHeader={() => (
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
      )}
      renderMode={(mode, state) => (
        <WorkspacePanelBody
          mode={mode}
          state={state}
        />
      )}
    />
  )
}
