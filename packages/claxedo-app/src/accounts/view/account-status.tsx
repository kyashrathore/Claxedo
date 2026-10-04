import type { Component } from "solid-js"
import { useAgeClock } from "@/lib/clock"
import { formatCompactAge, formatRelativeTime } from "@/lib/relative-time"
import type { AccountsKey, AccountsText } from "../i18n"
import type { AccountReach } from "../model"

export const ACCOUNT_REACH_KEYS = {
  "local-and-cloud": { label: "settings.providers.agents.reachLocalCloud", note: "settings.providers.agents.reachLocalCloudNote" },
  "local-only": { label: "settings.providers.agents.reachLocalOnly", note: "settings.providers.agents.reachLocalOnlyNote" },
} as const satisfies Record<AccountReach, { label: AccountsKey; note: AccountsKey }>

export const CheckedAge: Component<{ at: number; t: AccountsText; locale?: string; class?: string }> = (props) => {
  const now = useAgeClock(() => props.at)
  return (
    <span class={props.class} aria-label={props.t("common.lastChecked", { ago: formatRelativeTime(props.at, props.locale, now()) })}>
      {formatCompactAge(props.at, now()) ?? props.t("common.justNow")}
    </span>
  )
}
