import { For, Show, createMemo } from "solid-js"
import type { UsageSeries } from "../data/usage-api"

const WIDTH = 760
const HEIGHT = 190
const PAD = 18

const total = (point: UsageSeries["daily"][number]) => point.input + point.output + point.reasoning + point.cacheRead + point.cacheWrite

export function UsageChart(props: { series: UsageSeries; metric: "tokens" | "cost" }) {
  const points = createMemo(() => {
    const rows = props.series.daily
    const peak = Math.max(1, ...rows.map(total))
    return rows.map((row, index) => ({
      ...row,
      value: total(row),
      x: rows.length <= 1 ? WIDTH / 2 : PAD + index * ((WIDTH - PAD * 2) / (rows.length - 1)),
      y: HEIGHT - PAD - (total(row) / peak) * (HEIGHT - PAD * 2),
    }))
  })
  const path = createMemo(() => points().map((point, index) => `${index ? "L" : "M"}${point.x},${point.y}`).join(" "))
  return (
    <section class="usage-chart-shell" aria-labelledby="usage-chart-title">
      <div class="usage-section-heading">
        <div>
          <span class="usage-kicker">Daily signal</span>
          <h3 id="usage-chart-title">{props.metric === "tokens" ? "Provider-reported tokens" : "Estimated API cost"}</h3>
        </div>
        <span class="usage-chart-legend"><i /> Daily total</span>
      </div>
      <Show when={points().length > 0} fallback={<div class="usage-chart-empty">No measured usage in this range.</div>}>
        <div class="usage-chart-frame">
          <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Daily usage chart" preserveAspectRatio="none">
            <defs>
              <linearGradient id="usage-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="var(--usage-accent)" stop-opacity="0.28" />
                <stop offset="1" stop-color="var(--usage-accent)" stop-opacity="0" />
              </linearGradient>
            </defs>
            <g class="usage-chart-grid" aria-hidden="true">
              <line x1={PAD} y1="48" x2={WIDTH - PAD} y2="48" />
              <line x1={PAD} y1="95" x2={WIDTH - PAD} y2="95" />
              <line x1={PAD} y1="142" x2={WIDTH - PAD} y2="142" />
            </g>
            <path class="usage-chart-area" d={`${path()} L${points().at(-1)!.x},${HEIGHT - PAD} L${points()[0]!.x},${HEIGHT - PAD} Z`} />
            <path class="usage-chart-line" d={path()} />
            <For each={points()}>{(point) => (
              <circle
                class="usage-chart-point"
                cx={point.x}
                cy={point.y}
                r="4"
                tabindex="0"
                role="img"
                aria-label={`${point.date}: ${point.value.toLocaleString()} tokens`}
              ><title>{point.date}: {point.value.toLocaleString()} tokens</title></circle>
            )}</For>
          </svg>
          <div class="usage-chart-axis" aria-hidden="true">
            <span>{points()[0]?.date}</span>
            <span>{points().at(-1)?.date}</span>
          </div>
        </div>
      </Show>
    </section>
  )
}
