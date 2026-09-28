import { createMemo, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { FailureNotice } from "@/lib/failure"
import type { UsageSummary } from "@/server"
import { dailyCost, dailyTokens, rangeDates } from "../daily-series"
import { usageDictionary } from "../i18n"
import type { UsageGroup, UsageMetric } from "../model"
import { Breakdown, type BreakdownPaging } from "./breakdown"
import { DailyChart } from "./daily-chart"
import { TokenMix } from "./token-mix"
import { useUsageFormats } from "./usage-formats"
import { UsageHeadline } from "./usage-headline"
import "./claxedo.css"

export function ClaxedoUsage(props: {
  readonly summary: UsageSummary
  readonly group: UsageGroup
  readonly metric: UsageMetric
  readonly paging: BreakdownPaging
  readonly onGroup: (group: UsageGroup) => void
  readonly onRefresh: () => void
}): JSX.Element {
  const t = useTranslator(usageDictionary)
  const format = useUsageFormats()
  const claxedo = () => props.summary.claxedo
  const dates = createMemo(() => rangeDates(props.summary.range))
  const points = createMemo(() => (props.metric === "cost" ? dailyCost(dates(), claxedo().cost.daily) : dailyTokens(dates(), claxedo().daily)))
  return (
    <section class="usage-claxedo" aria-label={t("usage.view.claxedo")}>
      <Show when={claxedo().status !== "available" && claxedo().error}>
        {(error) => <FailureNotice title={t("usage.claxedo.unavailable")} message={error()} retryLabel={t("usage.refresh")} onRetry={props.onRefresh} />}
      </Show>
      <Show when={claxedo().status !== "available" && !claxedo().error}>
        <p class="usage-empty">{t("usage.claxedo.unavailable")}</p>
      </Show>
      <UsageHeadline summary={props.summary} metric={props.metric} />
      <Show when={points()} fallback={<p class="usage-empty">{t("usage.daily.costUnavailable")}</p>}>
        {(daily) => <DailyChart points={daily()} value={props.metric === "cost" ? format.usd : format.count} />}
      </Show>
      <TokenMix totals={claxedo().totals} />
      <Breakdown
        rows={props.summary.breakdown?.rows ?? []}
        next={props.summary.breakdown?.next}
        group={props.group}
        metric={props.metric}
        paging={props.paging}
        onGroup={props.onGroup}
      />
    </section>
  )
}
