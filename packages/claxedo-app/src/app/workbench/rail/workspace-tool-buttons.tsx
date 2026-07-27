import { Show } from "solid-js"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { SemanticIcon, type SemanticIconConcept } from "@/ui/semantic-icon"
import type { WorkspacePanelNavigator } from "../../../features/workspaces/ui/panel/workspace-panel-state"

type WorkspacePanelButtonProps = {
  concept: SemanticIconConcept
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
        data-icon-interaction="binary"
        class="relative flex size-6 items-center justify-center rounded-sm text-text-weak transition-colors hover:bg-surface-base-hover hover:text-text-base [&_[data-slot=icon-svg]]:!size-3.5"
        aria-label={props.active ? `Close ${props.label}` : `Open ${props.label}`}
        aria-pressed={props.active ? "true" : "false"}
        onClick={props.onClick}
      >
        <Show when={props.attention}>
          <span class="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-surface-critical-strong" />
        </Show>
        <SemanticIcon concept={props.concept} size="small" />
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
          concept="files"
          label="Files"
          active={props.filesActive}
          onClick={() => props.onToggle("files")}
        />
        <Show when={props.showChanges}>
          <WorkspacePanelButton
            concept="changes"
            label="Changes"
            active={props.changesActive === true}
            onClick={() => props.onToggle("changes")}
          />
        </Show>
        <Show when={props.showProcesses}>
          <WorkspacePanelButton
            concept="processes"
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
