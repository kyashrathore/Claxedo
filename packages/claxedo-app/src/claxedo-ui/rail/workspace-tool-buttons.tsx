import { Show } from "solid-js"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { ClaxedoIcon as Icon } from "../components/claxedo-icon"
import type { WorkspacePanelNavigator } from "../workspace-panel/workspace-panel-state"

type WorkspacePanelButtonProps = {
  icon: "file-tree" | "code-lines" | "console" | "branch"
  label: string
  active: boolean
  attention?: boolean
  onClick: () => void
}

function WorkspacePanelButton(props: WorkspacePanelButtonProps) {
  return (
    <Tooltip value={props.active ? `Close ${props.label}` : `Open ${props.label}`}>
      <button
        type="button"
        class="relative flex h-8 w-8 items-center justify-center rounded text-text-weak transition-colors hover:bg-surface-base-hover hover:text-text-base"
        classList={{
          "bg-surface-base-hover text-text-base": props.active,
        }}
        aria-label={props.active ? `Close ${props.label}` : `Open ${props.label}`}
        aria-pressed={props.active ? "true" : "false"}
        onClick={props.onClick}
      >
        <Show when={props.attention}>
          <span class="absolute right-1 top-1 size-1.5 rounded-full bg-surface-critical-strong" />
        </Show>
        <Icon name={props.icon} size="small" />
      </button>
    </Tooltip>
  )
}

export function WorkspaceToolButtons(props: {
  available: boolean
  filesActive: boolean
  changesActive?: boolean
  processesActive?: boolean
  processesAttention?: boolean
  showChanges?: boolean
  showProcesses?: boolean
  onToggle: (navigator: WorkspacePanelNavigator) => void
}) {
  return (
    <Show when={props.available}>
      <WorkspacePanelButton
        icon="file-tree"
        label="Files"
        active={props.filesActive}
        onClick={() => props.onToggle("files")}
      />
      <Show when={props.showChanges}>
        <WorkspacePanelButton
          icon="branch"
          label="Changes"
          active={props.changesActive === true}
          onClick={() => props.onToggle("changes")}
        />
      </Show>
      <Show when={props.showProcesses}>
        <WorkspacePanelButton
          icon="console"
          label="Processes"
          active={props.processesActive === true}
          attention={props.processesAttention}
          onClick={() => props.onToggle("processes")}
        />
      </Show>
    </Show>
  )
}
