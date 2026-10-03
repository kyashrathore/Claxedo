import type { JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { SessionActivityFilter } from "@/server"
import { useSessionStores } from "@/session"
import { ClaxedoIcon, Tooltip } from "@/ui"
import { railDictionary, type RailKey } from "../i18n"

const STATES = {
  all: { heading: "rail.activity", label: "rail.activity.showWorking", icon: "circle-dashed" },
  working: { heading: "rail.activity.working", label: "rail.activity.showNeedsYou", icon: "bell" },
  "needs-you": { heading: "rail.activity.needsYou", label: "rail.activity.showAll", icon: "activity" },
} as const

export function activityHeading(filter: SessionActivityFilter): RailKey {
  return STATES[filter].heading
}

export function ActivityFilterToggle(): JSX.Element {
  const t = useTranslator(railDictionary)
  const inventory = useSessionStores().list.inventory
  const state = () => STATES[inventory.filter()]
  return <Tooltip value={t(state().label)}>
    <button type="button" aria-label={t(state().label)} data-activity-filter={inventory.filter()} class="ui-activity-filter-toggle ui-session-options-trigger flex shrink-0 items-center justify-center rounded-md text-icon-weak-base hover:text-icon-base hover:bg-surface-base-hover/35 focus-visible:ring-2 focus-visible:ring-border-interactive-base" onClick={() => void inventory.cycleFilter()}>
      <ClaxedoIcon name={state().icon} size="small" />
    </button>
  </Tooltip>
}
