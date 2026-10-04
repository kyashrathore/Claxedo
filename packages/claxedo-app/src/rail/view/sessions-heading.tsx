import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { machine, unreachable, type Machine } from "@/lib/machine"
import type { ActivityFilter } from "@/session"
import { usePreferences } from "@/settings"
import { ClaxedoIcon as Icon, DropdownMenu, Tooltip } from "@/ui"
import { railDictionary, type RailKey } from "../i18n"

export type ActivityFilterState = { readonly kind: ActivityFilter }

export type ActivityFilterEvent = { readonly type: "cycled" } | { readonly type: "reset" }

const NEXT: Readonly<Record<ActivityFilter, ActivityFilter>> = { all: "working", working: "needsYou", needsYou: "all" }

export function activityFilterTransition(state: ActivityFilterState, event: ActivityFilterEvent): ActivityFilterState {
  switch (event.type) {
    case "cycled":
      return { kind: NEXT[state.kind] }
    case "reset":
      return state.kind === "all" ? state : { kind: "all" }
    default:
      return unreachable(event)
  }
}

export const createActivityFilter = (): Machine<ActivityFilterState, ActivityFilterEvent> => machine({ kind: "all" }, activityFilterTransition)

const FILTER_STATES = {
  all: { heading: "rail.activity", next: "rail.activity.showWorking", icon: "circle-dashed" },
  working: { heading: "rail.activity.working", next: "rail.activity.showNeedsYou", icon: "circle-alert" },
  needsYou: { heading: "rail.activity.needsYou", next: "rail.activity.showAll", icon: "circle-half" },
} as const satisfies Record<ActivityFilter, { readonly heading: RailKey; readonly next: RailKey; readonly icon: string }>

const OPTION_BUTTON = "flex size-7 max-md:size-11 shrink-0 items-center justify-center rounded-md text-icon-weak-base hover:text-icon-base hover:bg-surface-base-hover/40"

function SessionOptions(props: { readonly onShowWorking: () => void }): JSX.Element {
  const t = useTranslator(railDictionary)
  const preferences = usePreferences()
  return (
    <DropdownMenu placement="bottom-end" gutter={4}>
      <Tooltip value={t("rail.options")}>
        <DropdownMenu.Trigger aria-label={t("rail.options")} class={OPTION_BUTTON}>
          <Icon name="sliders" size="small" />
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content aria-label={t("rail.options")}>
          <DropdownMenu.RadioGroup value={preferences.sidebar.view} onChange={(view: string) => preferences.setSidebar("view", view === "activity" ? "activity" : "projects")}>
            <DropdownMenu.GroupLabel>{t("rail.options.view")}</DropdownMenu.GroupLabel>
            <DropdownMenu.RadioItem value="projects" closeOnSelect>{t("rail.projects")}</DropdownMenu.RadioItem>
            <DropdownMenu.RadioItem value="activity" closeOnSelect>{t("rail.activity")}</DropdownMenu.RadioItem>
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator />
          <DropdownMenu.CheckboxItem checked={preferences.sidebar.showSettled} closeOnSelect={false} onChange={(shown: boolean) => preferences.setSidebar("showSettled", shown)}>
            {t("rail.options.showSettled")}
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.CheckboxItem checked={preferences.sidebar.hideWorkingStatus} closeOnSelect={false} onChange={(hidden: boolean) => {
              preferences.setSidebar("hideWorkingStatus", hidden)
              if (!hidden) props.onShowWorking()
            }}>
            {t("rail.options.hideWorking")}
          </DropdownMenu.CheckboxItem>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}

export function SessionsHeading(props: { readonly filter: ActivityFilter; readonly onCycle: () => void; readonly onShowWorking: () => void }): JSX.Element {
  const t = useTranslator(railDictionary)
  const preferences = usePreferences()
  const activity = () => preferences.sidebar.view === "activity"
  const state = () => FILTER_STATES[props.filter]
  return (
    <div class="flex items-center justify-between gap-1 pl-4 pr-2.5 pt-1.5">
      <h2 class="sidebar-section-label min-w-0 truncate">{t(activity() ? state().heading : "rail.projects")}</h2>
      <div class="flex items-center">
        <Show when={activity() && preferences.sidebar.hideWorkingStatus}>
          <Tooltip value={t(state().next)}>
            <button type="button" aria-label={t(state().next)} class={OPTION_BUTTON} onClick={() => props.onCycle()}>
              <Icon name={state().icon} size="small" />
            </button>
          </Tooltip>
        </Show>
        <SessionOptions onShowWorking={props.onShowWorking} />
      </div>
    </div>
  )
}
