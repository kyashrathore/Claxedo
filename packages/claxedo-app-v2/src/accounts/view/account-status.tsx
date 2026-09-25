import { For, type Component } from "solid-js"
import { useClock } from "@/lib/clock"
import { formatCompactAge, formatRelativeTime } from "@/lib/relative-time"
import { ClaxedoIcon } from "@/ui"
import type { AccountsKey, AccountsText } from "../i18n"
import type { AccountReach } from "../model"

export const ACCOUNT_REACH_KEYS = {
  "local-and-cloud": {
    places: [
      { icon: "monitor", label: "settings.providers.agents.reachLocal" },
      { icon: "cloud", label: "settings.providers.agents.reachCloud" },
    ],
    note: "settings.providers.agents.reachLocalCloudNote",
  },
  "local-only": {
    places: [{ icon: "monitor", label: "settings.providers.agents.reachLocal" }],
    note: "settings.providers.agents.reachLocalOnlyNote",
  },
} as const satisfies Record<AccountReach, { places: ReadonlyArray<{ icon: string; label: AccountsKey }>; note: AccountsKey }>

export const AccountReachMarks: Component<{ reach: AccountReach; t: AccountsText; class?: string; iconClass?: string }> = (props) => (
  <span class={props.class} data-reach={props.reach}>
    <For each={ACCOUNT_REACH_KEYS[props.reach].places}>
      {(place) => <ClaxedoIcon name={place.icon} size="small" class={props.iconClass} role="img" aria-hidden="false" aria-label={props.t(place.label)} />}
    </For>
  </span>
)

export const CheckedAge: Component<{ at: number; t: AccountsText; locale?: string; class?: string }> = (props) => {
  const now = useClock()
  return (
    <span class={props.class} aria-label={props.t("common.lastChecked", { ago: formatRelativeTime(props.at, props.locale, now()) })}>
      {formatCompactAge(props.at, now()) ?? props.t("common.justNow")}
    </span>
  )
}
