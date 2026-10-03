import type { JSX } from "solid-js"
import { ClaxedoIcon, Tooltip, type ClaxedoIconProps } from "@/ui"
import type { HoverEngagement } from "../hover-engagement"

export function ActivityPlacement(props: { readonly name: string; readonly icon: ClaxedoIconProps["name"]; readonly engagement: HoverEngagement }): JSX.Element {
  const focused = () => props.engagement.focusedTarget()?.getAttribute("data-slot") === "activity-placement"
  return (
    <Tooltip value={props.name} forceOpen={focused()} class="ui-activity-placement-trigger" contentClass="ui-session-tooltip">
      <span role="img" tabIndex={0} data-slot="activity-placement" aria-label={props.name} class="ui-activity-placement pointer-events-auto flex shrink-0 items-center justify-center rounded text-icon-weak-base focus-visible:ring-2 focus-visible:ring-border-interactive-base">
        <ClaxedoIcon name={props.icon} size="small" />
      </span>
    </Tooltip>
  )
}
