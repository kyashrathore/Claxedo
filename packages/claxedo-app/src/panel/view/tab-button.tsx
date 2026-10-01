import type { JSX } from "solid-js"
import { AgentGlyph } from "@/transcript"
import { ClaxedoIcon as Icon, SidePanelTab, type ClaxedoIconName } from "@/ui"
import type { ReviewWorkspaceTab } from "../workspace-tabs"

export type ReviewWorkspaceTabButtonProps = {
  tab: ReviewWorkspaceTab
  selected: boolean
  label: string
  icon: ClaxedoIconName
  iconPx: number
  closeLabel: string
  onActivate: () => void
  onClose: () => void
  closable: boolean
}

export function ReviewWorkspaceTabButton(props: ReviewWorkspaceTabButtonProps): JSX.Element {
  return (
    <SidePanelTab
      data-slot="workspace-tab"
      data-workspace-tab-id={props.tab.id}
      data-workspace-tab-kind={props.tab.kind}
      selected={props.selected}
      label={props.label}
      closeLabel={props.closeLabel}
      closable={props.closable}
      onActivate={props.onActivate}
      onClose={props.onClose}
      closeAttributes={{ "data-testid": "workspace-tab-close", "data-workspace-tab-id": props.tab.id }}
      icon={
        props.tab.kind === "subagent" ? (
          <span class="flex size-4 shrink-0 items-center justify-center">
            <AgentGlyph seed={props.tab.sessionId} size={props.iconPx} />
          </span>
        ) : (
          <Icon
            name={props.icon}
            size="small"
            style={{ width: `${props.iconPx}px`, height: `${props.iconPx}px`, margin: `${(16 - props.iconPx) / 2}px` }}
            classList={{ "text-icon-base": props.selected, "text-icon-weak-base": !props.selected }}
          />
        )
      }
    />
  )
}
