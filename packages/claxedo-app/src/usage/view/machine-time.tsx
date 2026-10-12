import { createMemo, For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { openExternal } from "@/lib/external-link"
import type { MachineTime, MachineTimeProvider } from "@/server"
import { cloudCost } from "../cloud-rows"
import { usageDictionary } from "../i18n"
import { wholeMinutes } from "../model"
import { useUsageFormats } from "./usage-formats"

function ProviderBilling(props: { readonly provider: MachineTimeProvider }): JSX.Element {
  const t = useTranslator(usageDictionary)
  const host = () => new URL(props.provider.source.url).host
  return (
    <li class="usage-hint">
      <span>{props.provider.meter}</span>{" "}
      <Show when={props.provider.excludes}>{(excludes) => <span>{t("usage.cloud.excludes", { what: excludes() })}</span>}</Show>{" "}
      <span>
        {t("usage.cloud.source", { date: props.provider.source.readOn })}{" "}
        <a href={props.provider.source.url} class="usage-link" onClick={(event) => { event.preventDefault(); openExternal(props.provider.source.url) }}>{host()}</a>
      </span>
    </li>
  )
}

export function MachineTimeSummary(props: { readonly time: MachineTime }): JSX.Element {
  const t = useTranslator(usageDictionary)
  const format = useUsageFormats()
  const cost = createMemo(() => cloudCost(props.time.workspaces))
  return (
    <section class="usage-machine-time" aria-labelledby="usage-machine-time-title">
      <h3 id="usage-machine-time-title" class="usage-group-title">{t("usage.machineTime.title")}</h3>
      <dl class="usage-stats" aria-label={t("usage.machineTime.title")}>
        <div class="usage-stat" data-lead={true}>
          <dt>{t("usage.machineTime.minutesLabel")}</dt>
          <dd>{t("usage.machineTime.minutes", { minutes: format.whole(wholeMinutes(props.time.activeMs)) })}</dd>
        </div>
        <div class="usage-stat">
          <dt>{t("usage.machineTime.cost")}</dt>
          <dd>{cost().pricedMs > 0 || cost().unpricedMs === 0 ? format.money(cost().usd) : t("usage.unknown")}</dd>
        </div>
        <Show when={props.time.running > 0}>
          <div class="usage-stat">
            <dt>{t("usage.machineTime.runningLabel")}</dt>
            <dd>{format.whole(props.time.running)}</dd>
          </div>
        </Show>
      </dl>
      <p class="usage-hint">{t("usage.machineTime.hint")}</p>
      <Show when={cost().unpricedMs > 0}>
        <p class="usage-hint">{t("usage.machineTime.unpriced", { minutes: format.whole(wholeMinutes(cost().unpricedMs)), providers: cost().unpricedProviders.join(", ") })}</p>
      </Show>
      <Show when={props.time.providers.length > 0}>
        <ul class="usage-billing" aria-label={t("usage.cloud.billing")}>
          <For each={props.time.providers}>{(provider) => <ProviderBilling provider={provider} />}</For>
        </ul>
      </Show>
    </section>
  )
}
