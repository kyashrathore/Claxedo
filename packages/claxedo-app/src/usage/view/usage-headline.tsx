import { For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { UsageSummary } from "@/server"
import { costEstimate } from "../cost-estimate"
import { usageDictionary } from "../i18n"
import { totalTokens, type UsageMetric } from "../model"
import { useUsageFormats } from "./usage-formats"

export function UsageHeadline(props: { readonly summary: UsageSummary; readonly metric: UsageMetric }): JSX.Element {
  const t = useTranslator(usageDictionary)
  const format = useUsageFormats()
  const totals = () => props.summary.claxedo.totals
  const cost = () => costEstimate(props.summary.claxedo.cost, totals())
  const stats = () => {
    const tokens = { label: t("usage.totals.tokens"), value: format.count(totalTokens(totals())) }
    const turns = { label: t("usage.totals.turns"), value: format.whole(totals().turnCount) }
    const estimate = { label: t("usage.totals.cost"), value: format.cost(cost()) }
    return props.metric === "cost" ? [estimate, tokens, turns] : [tokens, turns, estimate]
  }
  const hint = () => {
    const kind = cost().kind
    if (kind === "unknown") return t("usage.cost.unknownHint")
    return kind === "partial" ? t("usage.cost.partialHint") : undefined
  }
  return (
    <div class="usage-headline">
      <dl class="usage-stats" aria-label={t("usage.totals")}>
        <For each={stats()}>
          {(stat, index) => (
            <div class="usage-stat" data-lead={index() === 0}>
              <dt>{stat.label}</dt>
              <dd>{stat.value}</dd>
            </div>
          )}
        </For>
      </dl>
      <Show when={hint()}>{(text) => <p class="usage-hint">{text()}</p>}</Show>
    </div>
  )
}
