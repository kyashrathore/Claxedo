import { For, Show, createMemo } from "solid-js"
import type { UsageBreakdownPage, UsageBreakdownRow, UsageTotals } from "../data/usage-api"
import { UsageBrandLabel, usageBrand } from "./usage-brand"

function tokens(row: Pick<UsageTotals, "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite">) {
  return row.input + row.output + row.reasoning + row.cacheRead + row.cacheWrite
}

function coverage(row: UsageBreakdownRow) {
  if (row.status === "unavailable") return "Usage unavailable"
  if (row.status === "unpriced") return `${row.unpricedTokens.toLocaleString()} tokens unpriced`
  if (row.unknownCategories > 0) return `${row.unknownCategories.toLocaleString()} categories unknown`
  return row.status === "partial" ? "Partial turn coverage" : "All categories measured"
}

function categories(row: UsageBreakdownRow) {
  return `In ${row.input.toLocaleString()} · Out ${row.output.toLocaleString()} · Reason ${row.reasoning.toLocaleString()} · Cache ${(
    row.cacheRead + row.cacheWrite
  ).toLocaleString()}`
}

export function UsageBreakdown(props: {
  breakdown?: UsageBreakdownPage
  totals: UsageTotals
  group: string
  hasPrevious?: boolean
  busy?: boolean
  onNext?: (cursor: string) => void
  onPrevious?: () => void
}) {
  const rows = createMemo(() => props.breakdown?.rows ?? [])
  const total = createMemo(() => Math.max(1, tokens(props.totals)))
  return (
    <section class="usage-breakdown" aria-labelledby="usage-breakdown-title">
      <div class="usage-section-heading">
        <div>
          <span class="usage-kicker">Attribution</span>
          <h3 id="usage-breakdown-title">By {props.group}</h3>
        </div>
        <span class="usage-breakdown-count">{rows().length} groups</span>
      </div>
      <Show when={rows().length} fallback={<div class="usage-breakdown-empty">No attributed rows for this range.</div>}>
        <div class="usage-breakdown-table" role="table" aria-label={`Usage grouped by ${props.group}`}>
          <div class="usage-breakdown-head" role="row">
            <span role="columnheader">{props.group}</span>
            <span role="columnheader">Tokens</span>
            <span role="columnheader">Est. cost</span>
            <span role="columnheader">Share</span>
          </div>
          <For each={rows()}>
            {(row) => {
              const rowTokens = () => tokens(row)
              return (
                <div
                  class={`usage-breakdown-row usage-brand-row-${usageBrand(`${row.value} ${row.label}`)}`}
                  role="row"
                  title={`${categories(row)} · ${coverage(row)}`}
                >
                  <span class="usage-breakdown-label" role="cell" title={row.label}>
                    <Show when={row.href} fallback={<UsageBrandLabel value={row.value} label={row.label} />} keyed>
                      {(href) => (
                        <a href={href}>
                          <UsageBrandLabel value={row.value} label={row.label} />
                        </a>
                      )}
                    </Show>
                  </span>
                  <span role="cell">{rowTokens().toLocaleString()}</span>
                  <span role="cell">
                    $
                    {row.estimatedUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                  <span role="cell" class="usage-share">
                    <i style={{ width: `${Math.min(100, (rowTokens() / total()) * 100)}%` }} />
                    <b>{Math.round((rowTokens() / total()) * 100)}%</b>
                  </span>
                </div>
              )
            }}
          </For>
        </div>
        <Show when={props.hasPrevious || props.breakdown?.next}>
          <nav class="usage-breakdown-pagination" aria-label="Breakdown pages">
            <button
              type="button"
              disabled={props.busy || !props.hasPrevious}
              aria-label="Previous breakdown page"
              onClick={() => props.onPrevious?.()}
            >
              Previous
            </button>
            <button
              type="button"
              disabled={props.busy || !props.breakdown?.next}
              aria-label="Next breakdown page"
              onClick={() => props.breakdown?.next && props.onNext?.(props.breakdown.next)}
            >
              Next
            </button>
          </nav>
        </Show>
      </Show>
    </section>
  )
}
