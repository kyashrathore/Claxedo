import { For, Show, type JSX } from "solid-js"
import { useI18n, useTranslator } from "@/i18n"
import type { UsageSummary } from "@/server"
import { Button } from "@opencode-ai/ui/button"
import { dictionary } from "../i18n"
import { totalTokens, type BreakdownRow, type UsageGroup, type UsageMetric } from "../model"

export type BreakdownPaging = {
  readonly hasPrevious: boolean
  readonly previous: () => void
  readonly next: (cursor: string) => void
}

function useFormats() {
  const i18n = useI18n()
  return {
    count: (value: number) => new Intl.NumberFormat(i18n.intlTag(), { notation: "compact", maximumFractionDigits: 2 }).format(value),
    cost: (value: number) => new Intl.NumberFormat(i18n.intlTag(), { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value),
  }
}

function Totals(props: { readonly summary: UsageSummary }): JSX.Element {
  const t = useTranslator(dictionary)
  const format = useFormats()
  const totals = () => props.summary.claxedo.totals
  const items = () => [
    [t("usage.totals.turns"), format.count(totals().turnCount)],
    [t("usage.totals.tokens"), format.count(totalTokens(totals()))],
    [t("usage.totals.input"), format.count(totals().input)],
    [t("usage.totals.output"), format.count(totals().output)],
    [t("usage.totals.reasoning"), format.count(totals().reasoning)],
    [t("usage.totals.cache"), format.count(totals().cacheRead + totals().cacheWrite)],
    [t("usage.totals.cost"), format.cost(props.summary.claxedo.cost.estimatedUsd)],
  ]
  return (
    <dl class="usage-totals" aria-label={t("usage.totals")}>
      <For each={items()}>
        {([label, value]) => (
          <div class="usage-total">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        )}
      </For>
    </dl>
  )
}

function BreakdownTable(props: { readonly rows: readonly BreakdownRow[]; readonly group: UsageGroup; readonly metric: UsageMetric }): JSX.Element {
  const t = useTranslator(dictionary)
  const format = useFormats()
  const measure = (row: BreakdownRow) => (props.metric === "cost" ? format.cost(row.estimatedUsd) : format.count(totalTokens(row)))
  return (
    <table class="usage-table" aria-label={t(props.group === "model" ? "usage.breakdown.model" : "usage.breakdown.provider")}>
      <thead>
        <tr>
          <th scope="col">{t("usage.breakdown.name")}</th>
          <th scope="col">{t("usage.totals.turns")}</th>
          <th scope="col">{t(props.metric === "cost" ? "usage.totals.cost" : "usage.totals.tokens")}</th>
        </tr>
      </thead>
      <tbody>
        <For each={props.rows}>
          {(row) => (
            <tr>
              <th scope="row">{row.label}</th>
              <td>{format.count(row.turnCount)}</td>
              <td>{measure(row)}</td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  )
}

function DailyBars(props: { readonly summary: UsageSummary; readonly metric: UsageMetric }): JSX.Element {
  const t = useTranslator(dictionary)
  const format = useFormats()
  const days = () => {
    const current = props.summary.claxedo
    if (props.metric === "cost") return (current.cost.daily ?? []).map((day) => ({ date: day.date, value: day.estimatedUsd, label: format.cost(day.estimatedUsd) }))
    return current.daily.map((day) => ({ date: day.date, value: totalTokens(day), label: format.count(totalTokens(day)) }))
  }
  const peak = () => Math.max(0, ...days().map((day) => day.value))
  return (
    <Show when={peak() > 0}>
      <figure class="usage-daily" aria-label={t("usage.daily")}>
        <For each={days()}>
          {(day) => (
            <div class="usage-daily-day" title={t("usage.daily.day", { date: day.date, value: day.label })}>
              <i style={{ height: `${Math.max(2, (day.value / peak()) * 100)}%` }} />
            </div>
          )}
        </For>
      </figure>
    </Show>
  )
}

export function ClaxedoUsage(props: {
  readonly summary: UsageSummary
  readonly group: UsageGroup
  readonly metric: UsageMetric
  readonly paging: BreakdownPaging
}): JSX.Element {
  const t = useTranslator(dictionary)
  const rows = () => props.summary.breakdown?.rows ?? []
  const unavailable = () => (props.summary.claxedo.status === "available" ? undefined : (props.summary.claxedo.error ?? t("usage.claxedo.unavailable")))
  return (
    <section class="usage-claxedo" aria-label={t("usage.view.claxedo")}>
      <Show when={unavailable()}>{(message) => <p class="usage-note" data-tone="danger" role="alert">{message()}</p>}</Show>
      <Totals summary={props.summary} />
      <DailyBars summary={props.summary} metric={props.metric} />
      <Show when={rows().length > 0} fallback={<p class="usage-note">{t("usage.breakdown.empty")}</p>}>
        <BreakdownTable rows={rows()} group={props.group} metric={props.metric} />
      </Show>
      <div class="usage-paging">
        <Show when={props.paging.hasPrevious}>
          <Button size="small" variant="ghost" onClick={() => props.paging.previous()}>
            {t("usage.breakdown.previous")}
          </Button>
        </Show>
        <Show when={props.summary.breakdown?.next}>
          {(cursor) => (
            <Button size="small" variant="ghost" onClick={() => props.paging.next(cursor())}>
              {t("usage.breakdown.next")}
            </Button>
          )}
        </Show>
      </div>
      <p class="usage-note">{t("usage.unknownCategories")}</p>
    </section>
  )
}
