import { For, Show, createMemo, createSignal } from "solid-js"
import { monotonePath } from "@/ui/charts/monotone-path"
import type { UsageChartSeries, UsageCost, UsageSeries } from "../data/usage-api"
import { UsageBrandLabel, usageBrand } from "./usage-brand"

const WIDTH = 960
const HEIGHT = 260
const TICK_COUNT = 4
const PLOT_TOP = 8

const total = (
  point: Pick<UsageSeries["daily"][number], "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite">,
) => point.input + point.output + point.reasoning + point.cacheRead + point.cacheWrite

const compact = (value: number) =>
  new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value)

function niceScale(peak: number) {
  if (peak <= 0) return { max: 0, ticks: [0] }
  const rawStep = peak / TICK_COUNT
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const normalized = rawStep / magnitude
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude
  const max = Math.ceil(peak / step) * step
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, index) => index * step)
  return { max, ticks }
}

export function UsageChart(props: {
  series: UsageSeries
  chart?: UsageChartSeries
  cost?: UsageCost
  metric: "tokens" | "cost"
}) {
  const [activeIndex, setActiveIndex] = createSignal<number>()
  const rows = createMemo(() => {
    const costs = new Map((props.cost?.daily ?? []).map((point) => [point.date, point.estimatedUsd]))
    if (props.metric === "cost")
      return [
        {
          value: "total",
          label: "Daily total",
          daily: [...new Set([...props.series.daily.map((point) => point.date), ...costs.keys()])]
            .toSorted()
            .map((date) => ({ date, value: costs.get(date) ?? 0 })),
        },
      ]
    const grouped = (props.chart?.series ?? [])
      .map((series) => ({
        value: series.value,
        label: series.label,
        daily: series.daily.map((point) => ({ date: point.date, value: total(point) })),
      }))
      .toSorted(
        (a, b) =>
          b.daily.reduce((sum, point) => sum + point.value, 0) - a.daily.reduce((sum, point) => sum + point.value, 0),
      )
    if (grouped.length > 6) {
      const retained = grouped.slice(0, 5)
      const remainder = grouped.slice(5)
      const remainderDates = [
        ...new Set(remainder.flatMap((series) => series.daily.map((point) => point.date))),
      ].toSorted()
      retained.push({
        value: "other",
        label: "Other",
        daily: remainderDates.map((date) => ({
          date,
          value: remainder.reduce(
            (sum, series) => sum + (series.daily.find((point) => point.date === date)?.value ?? 0),
            0,
          ),
        })),
      })
      return retained
    }
    return grouped.length > 0
      ? grouped
      : [
          {
            value: "total",
            label: "Daily total",
            daily: props.series.daily.map((point) => ({ date: point.date, value: total(point) })),
          },
        ]
  })
  const dates = createMemo(() =>
    [...new Set(rows().flatMap((series) => series.daily.map((point) => point.date)))].toSorted(),
  )
  const scale = createMemo(() => {
    const values = rows().map((series) => new Map(series.daily.map((point) => [point.date, point.value])))
    const peak = Math.max(0, ...dates().map((date) => values.reduce((sum, series) => sum + (series.get(date) ?? 0), 0)))
    return niceScale(peak)
  })
  const toY = (value: number) => (scale().max === 0 ? HEIGHT : HEIGHT - (value / scale().max) * (HEIGHT - PLOT_TOP))
  const stepX = createMemo(() => (dates().length <= 1 ? 0 : WIDTH / (dates().length - 1)))
  const rendered = createMemo(() => {
    const cumulative = new Map(dates().map((date) => [date, 0]))
    return rows().map((series) => {
      const values = new Map(series.daily.map((point) => [point.date, point.value]))
      const points = dates().map((date, index) => {
        const value = values.get(date) ?? 0
        const bottom = cumulative.get(date) ?? 0
        const top = bottom + value
        cumulative.set(date, top)
        return {
          date,
          value,
          bottom,
          top,
          x: dates().length <= 1 ? WIDTH / 2 : index * stepX(),
          y: toY(top),
          bottomY: toY(bottom),
        }
      })
      const path = points.length === 1 ? `M0,${points[0]!.y} L${WIDTH},${points[0]!.y}` : monotonePath(points)
      const bottomPoints = points.map((point) => ({ x: point.x, y: point.bottomY })).reverse()
      const bottomPath =
        points.length === 1
          ? `L${WIDTH},${points[0]!.bottomY} L0,${points[0]!.bottomY}`
          : monotonePath(bottomPoints).replace(/^M/, "L")
      return {
        ...series,
        brand: usageBrand(`${series.value} ${series.label}`),
        points,
        path,
        areaPath: `${path} ${bottomPath} Z`,
      }
    })
  })
  const active = createMemo(() => {
    const index = activeIndex()
    if (index === undefined) return
    return {
      index,
      date: dates()[index]!,
      x: rendered()[0]?.points[index]?.x ?? 0,
      rows: rendered().map((series) => ({ ...series, point: series.points[index]! })),
    }
  })
  const valueLabel = (value: number) =>
    props.metric === "cost"
      ? `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : `${compact(value)} tokens`
  const dateLabel = (date: string) =>
    new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
  const ariaSummary = createMemo(
    () =>
      `${props.metric === "cost" ? "Daily estimated API cost" : `Daily tokens by ${props.chart?.dimension ?? "total"}`}. ${rows()
        .map((row) => row.label)
        .join(
          ", ",
        )}. ${dates()[0] ?? "No dates"} to ${dates().at(-1) ?? "no dates"}. Peak ${scale().max.toLocaleString()}.`,
  )
  const setNearestDay = (clientX: number, element: HTMLDivElement) => {
    const bounds = element.getBoundingClientRect()
    if (bounds.width === 0 || dates().length === 0) return
    const fraction = Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width))
    setActiveIndex(Math.round(fraction * (dates().length - 1)))
  }
  const moveFocus = (delta: number) =>
    setActiveIndex((current) => Math.min(dates().length - 1, Math.max(0, (current ?? 0) + delta)))

  return (
    <section class="workspace-data-chart usage-chart-shell" aria-labelledby="usage-chart-title">
      <div class="workspace-data-heading usage-section-heading">
        <div>
          <span class="workspace-data-kicker usage-kicker">Daily signal</span>
          <h3 id="usage-chart-title">
            {props.metric === "tokens" ? "Provider-reported tokens" : "Estimated API cost"}
          </h3>
        </div>
        <div class="workspace-data-legend usage-chart-series" aria-label="Chart series">
          <For each={rows()}>{(row) => <UsageBrandLabel value={row.value} label={row.label} />}</For>
        </div>
      </div>
      <Show when={dates().length > 0} fallback={<div class="usage-chart-empty">No measured usage in this range.</div>}>
        <div class="workspace-data-chart-frame usage-chart-frame">
          <div class="usage-chart-plot-row">
            <div class="workspace-data-y-axis usage-chart-y-axis" aria-hidden="true">
              <For each={scale().ticks}>
                {(tick) => (
                  <span style={{ bottom: `${(tick / Math.max(1, scale().max)) * 100}%` }}>
                    {tick === 0 ? "0" : compact(tick)}
                  </span>
                )}
              </For>
            </div>
            <div
              class="workspace-data-chart-plot usage-chart-plot"
              tabindex="0"
              onPointerMove={(event) => setNearestDay(event.clientX, event.currentTarget)}
              onPointerLeave={() => setActiveIndex(undefined)}
              onFocus={() => setActiveIndex((current) => current ?? 0)}
              onBlur={() => setActiveIndex(undefined)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
                event.preventDefault()
                moveFocus(event.key === "ArrowLeft" ? -1 : 1)
              }}
            >
              <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={ariaSummary()} preserveAspectRatio="none">
                <g class="workspace-data-chart-grid usage-chart-grid" aria-hidden="true">
                  <For each={scale().ticks}>{(tick) => <line x1="0" y1={toY(tick)} x2={WIDTH} y2={toY(tick)} />}</For>
                </g>
                <For each={rendered()}>
                  {(series) => (
                    <path
                      class={`workspace-data-chart-area usage-chart-area usage-chart-series-${series.brand}`}
                      d={series.areaPath}
                      data-stack-bottom={Math.min(...series.points.map((point) => point.bottom))}
                      data-stack-top={Math.max(...series.points.map((point) => point.top))}
                    />
                  )}
                </For>
                <For each={rendered()}>
                  {(series) => (
                    <path
                      class={`workspace-data-chart-line usage-chart-line usage-chart-series-${series.brand}`}
                      d={series.path}
                    />
                  )}
                </For>
                <Show when={active()} keyed>
                  {(focused) => (
                    <g class="usage-chart-active" aria-hidden="true">
                      <line x1={focused.x} y1={PLOT_TOP} x2={focused.x} y2={HEIGHT} />
                      <For each={focused.rows}>
                        {(series) => (
                          <circle
                            class={`workspace-data-chart-focus usage-chart-focus usage-chart-series-${series.brand}`}
                            cx={series.point.x}
                            cy={series.point.y}
                            r="4"
                          />
                        )}
                      </For>
                    </g>
                  )}
                </Show>
              </svg>
              <Show when={active()} keyed>
                {(focused) => (
                  <div
                    class="workspace-data-tooltip usage-chart-tooltip"
                    classList={{ "is-right": focused.x / WIDTH > 0.6 }}
                    style={{ left: `${(focused.x / WIDTH) * 100}%` }}
                    role="status"
                    aria-live="polite"
                  >
                    <strong>{dateLabel(focused.date)}</strong>
                    <For each={focused.rows}>
                      {(series) => (
                        <div>
                          <UsageBrandLabel value={series.value} label={series.label} />
                          <b>{valueLabel(series.point.value)}</b>
                        </div>
                      )}
                    </For>
                    <div class="workspace-data-tooltip-total usage-chart-tooltip-total">
                      <span>Total</span>
                      <b>{valueLabel(focused.rows.reduce((sum, series) => sum + series.point.value, 0))}</b>
                    </div>
                  </div>
                )}
              </Show>
            </div>
          </div>
          <div class="workspace-data-chart-axis usage-chart-axis" aria-hidden="true">
            <span>{dateLabel(dates()[0]!)}</span>
            <span>{dateLabel(dates()[Math.floor(dates().length / 2)]!)}</span>
            <span>{dateLabel(dates().at(-1)!)}</span>
          </div>
        </div>
      </Show>
    </section>
  )
}
