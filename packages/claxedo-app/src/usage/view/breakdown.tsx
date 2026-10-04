import { createMemo, createUniqueId, For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { Button } from "@/ui"
import { costEstimate } from "../cost-estimate"
import { usageDictionary } from "../i18n"
import { totalTokens, type BreakdownRow, type UsageGroup, type UsageMetric } from "../model"
import { Choices, type Choice } from "./choices"
import { useUsageFormats } from "./usage-formats"

export type BreakdownPaging = {
  readonly hasPrevious: boolean
  readonly previous: () => void
  readonly next: (cursor: string) => void
}

const GROUPS: readonly Choice<UsageGroup>[] = [
  { value: "provider", label: "usage.group.provider" },
  { value: "model", label: "usage.group.model" },
]

function measured(row: BreakdownRow, metric: UsageMetric): number {
  if (metric === "tokens") return row.status === "unavailable" ? 0 : totalTokens(row)
  const estimate = costEstimate(row, row)
  return estimate.kind === "partial" || estimate.kind === "complete" ? estimate.usd : 0
}

function BreakdownTable(props: { readonly rows: readonly BreakdownRow[]; readonly group: UsageGroup; readonly metric: UsageMetric }): JSX.Element {
  const t = useTranslator(usageDictionary)
  const format = useUsageFormats()
  const peak = createMemo(() => Math.max(0, ...props.rows.map((row) => measured(row, props.metric))))
  const share = (row: BreakdownRow) => (peak() > 0 ? (measured(row, props.metric) / peak()) * 100 : 0)
  return (
    <table class="usage-table" aria-label={t(props.group === "model" ? "usage.breakdown.model" : "usage.breakdown.provider")}>
      <thead>
        <tr>
          <th scope="col" class="usage-table-lead">{t("usage.breakdown.name")}</th>
          <th scope="col">{t("usage.totals.turns")}</th>
          <th scope="col">{t("usage.totals.tokens")}</th>
          <th scope="col">{t("usage.totals.cost")}</th>
        </tr>
      </thead>
      <tbody>
        <For each={props.rows}>
          {(row) => (
            <tr>
              <th scope="row" class="usage-table-lead">
                <span class="usage-table-name">{row.label}</span>
                <span class="usage-table-share" aria-hidden="true">
                  <i class="usage-table-share-bar" style={{ width: `${share(row)}%` }} />
                </span>
              </th>
              <td>{format.whole(row.turnCount)}</td>
              <td>{row.status === "unavailable" ? t("usage.unknown") : format.count(totalTokens(row))}</td>
              <td>{format.cost(costEstimate(row, row))}</td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  )
}

export function Breakdown(props: {
  readonly rows: readonly BreakdownRow[]
  readonly next: string | undefined
  readonly group: UsageGroup
  readonly metric: UsageMetric
  readonly paging: BreakdownPaging
  readonly onGroup: (group: UsageGroup) => void
}): JSX.Element {
  const t = useTranslator(usageDictionary)
  const titleId = createUniqueId()
  return (
    <section class="usage-breakdown" aria-labelledby={titleId}>
      <div class="usage-breakdown-head">
        <h3 id={titleId} class="usage-group-title">{t("usage.breakdown")}</h3>
        <Choices label={t("usage.group")} choices={GROUPS} value={props.group} onChange={props.onGroup} />
      </div>
      <Show when={props.rows.length > 0} fallback={<p class="usage-empty">{t("usage.breakdown.empty")}</p>}>
        <BreakdownTable rows={props.rows} group={props.group} metric={props.metric} />
      </Show>
      <Show when={props.paging.hasPrevious || props.next}>
        <div class="usage-paging">
          <Show when={props.paging.hasPrevious}>
            <Button size="small" variant="ghost" onClick={() => props.paging.previous()}>{t("usage.breakdown.previous")}</Button>
          </Show>
          <Show when={props.next}>
            {(cursor) => <Button size="small" variant="ghost" onClick={() => props.paging.next(cursor())}>{t("usage.breakdown.next")}</Button>}
          </Show>
        </div>
      </Show>
    </section>
  )
}
