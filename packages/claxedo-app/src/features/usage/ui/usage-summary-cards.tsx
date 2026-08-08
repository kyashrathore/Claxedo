import { For } from "solid-js"
import type { UsageCost, UsageTotals } from "../data/usage-api"

export type UsageView = "quota" | "claxedo" | "total"

function tokens(value: UsageTotals) {
  return value.input + value.output + value.reasoning + value.cacheRead + value.cacheWrite
}

function compact(value: number) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value)
}

export function UsageSummaryCards(props: {
  selected: UsageView
  onSelect: (view: UsageView) => void
  claxedo: UsageTotals
  total: UsageTotals
  claxedoCost: UsageCost
  totalCost: UsageCost
  quotaStatus: string
  metric: "tokens" | "cost"
}) {
  const cards = () => [
    {
      id: "quota" as const,
      eyebrow: "Provider windows",
      title: "Quota limits",
      value: props.quotaStatus === "available" ? "Live" : props.quotaStatus === "degraded" ? "Degraded" : "Unavailable",
      note: "Account limits & resets",
    },
    {
      id: "claxedo" as const,
      eyebrow: "Across your machines",
      title: "Claxedo usage",
      value: props.metric === "tokens" ? compact(tokens(props.claxedo)) : `$${props.claxedoCost.estimatedUsd.toFixed(2)}`,
      note: `${props.claxedo.turnCount.toLocaleString()} model turns`,
    },
    {
      id: "total" as const,
      eyebrow: "This machine + Claxedo",
      title: "Total usage",
      value: props.metric === "tokens" ? compact(tokens(props.total)) : `$${props.totalCost.estimatedUsd.toFixed(2)}`,
      note: props.totalCost.unpricedTokens > 0 ? `${compact(props.totalCost.unpricedTokens)} tokens unpriced` : "Known pricing coverage",
    },
  ]
  return (
    <div class="usage-summary-grid" role="group" aria-label="Usage views">
      <For each={cards()}>{(card, index) => (
        <button
          type="button"
          class="usage-summary-card"
          classList={{ "is-selected": props.selected === card.id }}
          aria-pressed={props.selected === card.id}
          onClick={() => props.onSelect(card.id)}
          style={{ "--usage-card-index": index() }}
        >
          <span class="usage-summary-index">0{index() + 1}</span>
          <span class="usage-summary-copy">
            <span class="usage-summary-eyebrow">{card.eyebrow}</span>
            <span class="usage-summary-title">{card.title}</span>
            <span class="usage-summary-note">{card.note}</span>
          </span>
          <span class="usage-summary-value">{card.value}</span>
        </button>
      )}</For>
    </div>
  )
}
