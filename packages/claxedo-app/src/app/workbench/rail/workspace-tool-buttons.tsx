import { Show } from "solid-js"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import type { WorkspacePanelNavigator } from "../../../features/workspaces/ui/panel/workspace-panel-state"

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
        class="relative flex size-6 items-center justify-center rounded-sm text-text-weak transition-colors hover:bg-surface-base-hover hover:text-text-base"
        classList={{
          // One-of-N navigator: the selected member carries a persistent fill
          // slightly stronger than hover so "which one is open" reads clearly.
          "bg-surface-base-active text-text-base": props.active,
        }}
        aria-label={props.active ? `Close ${props.label}` : `Open ${props.label}`}
        aria-pressed={props.active ? "true" : "false"}
        onClick={props.onClick}
      >
        <Show when={props.attention}>
          <span class="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-surface-critical-strong" />
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
      {/* One-of-N navigator group: tight internal gap so the trio reads as a
          single unit, matching the browser toolbar clusters. */}
      <div class="flex items-center gap-0.5">
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
      </div>
    </Show>
  )
}
