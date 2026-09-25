import { Show } from "solid-js"
import { SemanticIcon, type SemanticIconConcept, Tooltip } from "@/ui"
import type { WorkspacePanelNavigator } from "../workspace-tabs"

type WorkspacePanelButtonProps = {
  concept: SemanticIconConcept
  label: string
  active: boolean
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
        <SemanticIcon concept={props.concept} size="small" />
      </button>
    </Tooltip>
  )
}

export function WorkspaceToolButtons(props: {
  available: boolean
  filesActive: boolean
  changesActive?: boolean
  showChanges?: boolean
  onToggle: (navigator: WorkspacePanelNavigator) => void
}) {
  return (
    <Show when={props.available}>
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
      </div>
    </Show>
  )
}
