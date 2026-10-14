import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { usageDictionary } from "../i18n"
import type { UsageDays } from "../model"
import type { SandboxTotals } from "../sandbox-rows"
import { useUsageFormats } from "./usage-formats"

export function SandboxTotalsSummary(props: { readonly totals: SandboxTotals; readonly days: UsageDays }): JSX.Element {
  const t = useTranslator(usageDictionary)
  const format = useUsageFormats()
  const hourly = () => {
    const estimate = props.totals.hourly
    if (estimate.kind === "none" || estimate.kind === "unknown") return format.whole(props.totals.running)
    const rate = estimate.kind === "partial" ? t("usage.cost.atLeast", { amount: format.hourlyRate(estimate.usd) }) : format.hourlyRate(estimate.usd)
    return t("usage.sandbox.runningRate", { count: format.whole(props.totals.running), rate })
  }
  return (
    <dl class="usage-stats" aria-label={t("usage.totals")}>
      <div class="usage-stat" data-lead={true}>
        <dt>{t("usage.sandbox.rangeTotal", { days: props.days })}</dt>
        <dd>{format.spend(props.totals.cost)}</dd>
      </div>
      <div class="usage-stat">
        <dt>{t("usage.sandbox.machineTime")}</dt>
        <dd>{format.duration(props.totals.activeMs)}</dd>
      </div>
      <Show when={props.totals.running > 0}>
        <div class="usage-stat">
          <dt>{t("usage.sandbox.runningNow")}</dt>
          <dd>{hourly()}</dd>
        </div>
      </Show>
    </dl>
  )
}
