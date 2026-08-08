import { For, Show, createMemo } from "solid-js"
import type { UsageTotals } from "../data/usage-api"

type Row = { value: string; tokens: number; turns: number; unknown: number }

function normalize(value: unknown): Row[] {
  const body = value as { localRows?: Array<Record<string, unknown>>; central?: { rows?: Array<Record<string, unknown>> }; rows?: Array<Record<string, unknown>> } | undefined
  const source = [...(body?.central?.rows ?? body?.rows ?? []), ...(body?.localRows ?? [])]
  const rows = new Map<string, Row>()
  for (const item of source) {
    const label = String(item.value ?? "Unavailable")
    const current = rows.get(label) ?? { value: label, tokens: 0, turns: 0, unknown: 0 }
    current.tokens += Number(item.input_tokens ?? item.input ?? 0) + Number(item.output_tokens ?? item.output ?? 0)
      + Number(item.reasoning_tokens ?? item.reasoning ?? 0) + Number(item.cache_read_tokens ?? item.cacheRead ?? 0)
      + Number(item.cache_write_tokens ?? item.cacheWrite ?? 0)
    current.turns += Number(item.turn_count ?? item.turnCount ?? 0)
    current.unknown += Number(item.unknown_token_count ?? item.unknownCategories ?? 0)
    rows.set(label, current)
  }
  return [...rows.values()].toSorted((a, b) => b.tokens - a.tokens)
}

export function UsageBreakdown(props: { breakdown: unknown; totals: UsageTotals; group: string }) {
  const rows = createMemo(() => normalize(props.breakdown))
  const total = createMemo(() => Math.max(1, props.totals.input + props.totals.output + props.totals.reasoning + props.totals.cacheRead + props.totals.cacheWrite))
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
            <span role="columnheader">{props.group}</span><span role="columnheader">Tokens</span><span role="columnheader">Share</span><span role="columnheader">Turns</span>
          </div>
          <For each={rows()}>{(row) => (
            <div class="usage-breakdown-row" role="row">
              <span class="usage-breakdown-label" role="cell" title={row.value}>{row.value}</span>
              <span role="cell">{row.tokens.toLocaleString()}</span>
              <span role="cell" class="usage-share"><i style={{ width: `${Math.min(100, row.tokens / total() * 100)}%` }} /><b>{Math.round(row.tokens / total() * 100)}%</b></span>
              <span role="cell">{row.turns.toLocaleString()}</span>
            </div>
          )}</For>
        </div>
      </Show>
    </section>
  )
}
