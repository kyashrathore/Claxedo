import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"
import { monotonePath } from "@/ui/charts/monotone-path"

import type { DiagnosticsRange, DiagnosticsSeriesPoint } from "./model"
import type { LocalDiagnostics } from "../../data/local-diagnostics"

/* The chart draws in CSS pixels: the viewBox tracks the measured element width so
   type renders at its authored size instead of being scaled by `preserveAspectRatio`.
   `FALLBACK_WIDTH` keeps the geometry deterministic before the first measurement
   (and under test runtimes without a ResizeObserver). */
const FALLBACK_WIDTH = 800
const HEIGHT = 260
const PAD = { top: 26, right: 62, bottom: 26, left: 50 }
const PLOT_TOP = PAD.top
const PLOT_BOTTOM = HEIGHT - PAD.bottom
const Y_TICKS = 4
const X_TICKS = 4
const TOOLTIP_WIDTH = 232

export function DiagnosticsTimeline(props: {
  points: DiagnosticsSeriesPoint[]
  bounds: DiagnosticsRange
  spikes?: LocalDiagnostics.SpikeMarker[]
}) {
  const [width, setWidth] = createSignal(FALLBACK_WIDTH)
  const [hoveredAt, setHoveredAt] = createSignal<number>()
  let resizeObserver: ResizeObserver | undefined
  onCleanup(() => resizeObserver?.disconnect())
  const measure = (element: HTMLDivElement) => {
    resizeObserver?.disconnect()
    if (typeof ResizeObserver === "undefined") return
    resizeObserver = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? 0
      if (measured > 0) setWidth(Math.round(measured))
    })
    resizeObserver.observe(element)
  }

  const plotLeft = PAD.left
  const plotRight = createMemo(() => Math.max(plotLeft + 1, width() - PAD.right))
  const span = createMemo(() => Math.max(1, props.bounds.endAt - props.bounds.startAt))
  const x = (at: number) => plotLeft + ((at - props.bounds.startAt) / span()) * (plotRight() - plotLeft)
  const y = (value: number, top: number) => PLOT_BOTTOM - (value / top) * (PLOT_BOTTOM - PLOT_TOP)

  const cpuAxis = createMemo(() => niceAxis(peak(props.points, "cpu"), "percent"))
  const memoryAxis = createMemo(() => niceAxis(peak(props.points, "memoryImpactBytes"), "bytes"))
  const axisFor = (metric: LocalDiagnostics.SpikeMarker["metric"]) => (metric === "cpu" ? cpuAxis() : memoryAxis())
  const seriesPoints = (field: "cpu" | "memoryImpactBytes", top: number) =>
    props.points
      .filter((point) => point[field] !== undefined)
      .map((point) => ({ x: x(point.at), y: y(point[field]!, top) }))
  const seriesPath = (field: "cpu" | "memoryImpactBytes", top: number) => monotonePath(seriesPoints(field, top))
  const seriesAreaPath = (field: "cpu" | "memoryImpactBytes", top: number) => {
    const values = seriesPoints(field, top)
    if (values.length === 0) return ""
    const line = monotonePath(values)
    return `${line} L${values.at(-1)!.x},${PLOT_BOTTOM} L${values[0]!.x},${PLOT_BOTTOM} Z`
  }
  const xTicks = createMemo(() =>
    Array.from({ length: X_TICKS + 1 }, (_, index) => props.bounds.startAt + (index / X_TICKS) * span()),
  )

  /* Hover snaps to the nearest plotted sample so the readout always quotes a real
     measurement rather than an interpolated point on the trend line. */
  const hovered = createMemo(() => {
    const at = hoveredAt()
    if (at === undefined) return
    return props.points.reduce<DiagnosticsSeriesPoint | undefined>(
      (best, point) => (best === undefined || Math.abs(point.at - at) < Math.abs(best.at - at) ? point : best),
      undefined,
    )
  })
  /* The spikes that explain the hovered sample: anything attributed within half a
     sample interval of it, so a spike between two samples still names its cause. */
  const hoveredSpikes = createMemo(() => {
    const point = hovered()
    if (!point) return []
    return (props.spikes ?? []).filter((spike) => Math.abs(spike.at - point.at) <= sampleStep() / 2)
  })
  const sampleStep = createMemo(() => {
    const times = props.points.map((point) => point.at)
    const gaps = times
      .slice(1)
      .map((time, index) => time - times[index]!)
      .filter((gap) => gap > 0)
    return gaps.length > 0 ? Math.min(...gaps) : span()
  })

  const trackPointer = (event: PointerEvent & { currentTarget: SVGSVGElement }) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const local = ((event.clientX - rect.left) / Math.max(1, rect.width)) * width()
    const ratio = Math.max(0, Math.min(1, (local - plotLeft) / Math.max(1, plotRight() - plotLeft)))
    setHoveredAt(Math.round(props.bounds.startAt + ratio * span()))
  }

  return (
    <section aria-labelledby="diagnostics-timeline-title" class="workspace-data-chart diagnostics-chart-shell">
      <div class="workspace-data-heading">
        <div>
          <span class="workspace-data-kicker">Daily signal</span>
          <h3 id="diagnostics-timeline-title">CPU and memory history</h3>
        </div>
        <div class="workspace-data-legend diagnostics-chart-series" aria-label="Chart series">
          <span class="diagnostics-series diagnostics-series-cpu">
            <i />
            CPU
          </span>
          <span class="diagnostics-series diagnostics-series-memory">
            <i />
            Memory impact
          </span>
        </div>
      </div>
      <div class="workspace-data-chart-frame diagnostics-chart-frame">
        <div ref={measure} class="workspace-data-chart-plot diagnostics-chart-plot">
          <svg
            viewBox={`0 0 ${String(width())} ${String(HEIGHT)}`}
            width={width()}
            height={HEIGHT}
            class="block w-full touch-none select-none [font-variant-numeric:tabular-nums]"
            role="img"
            aria-label={chartLabel(props.bounds, cpuAxis(), memoryAxis(), props.points, props.spikes ?? [])}
            onPointerMove={trackPointer}
            onPointerLeave={() => setHoveredAt(undefined)}
          >
            {/* Horizontal grid — one band per tick, shared by both value axes. */}
            <g class="workspace-data-chart-grid" aria-hidden="true">
              <For each={cpuAxis().values}>
                {(value) => (
                  <line x1={plotLeft} x2={plotRight()} y1={y(value, cpuAxis().top)} y2={y(value, cpuAxis().top)} />
                )}
              </For>
            </g>
            <Show when={hovered()}>
              {(point) => (
                <line
                  data-testid="diagnostics-hover-guide"
                  x1={x(point().at)}
                  x2={x(point().at)}
                  y1={PLOT_TOP}
                  y2={PLOT_BOTTOM}
                  stroke="var(--text-weak)"
                  stroke-width="1"
                  shape-rendering="crispEdges"
                />
              )}
            </Show>

            <path
              class="workspace-data-chart-area diagnostics-chart-memory"
              d={seriesAreaPath("memoryImpactBytes", memoryAxis().top)}
            />
            <path class="workspace-data-chart-area diagnostics-chart-cpu" d={seriesAreaPath("cpu", cpuAxis().top)} />
            <path
              class="workspace-data-chart-line diagnostics-chart-memory"
              d={seriesPath("memoryImpactBytes", memoryAxis().top)}
            />
            <path class="workspace-data-chart-line diagnostics-chart-cpu" d={seriesPath("cpu", cpuAxis().top)} />

            {/* Attribution dots sit on the series at the spike's own value, so a spike is
              located in both time and magnitude. Filled means the collector captured a
              context for it; hollow means the jump is real but unattributed. */}
            <For each={props.spikes ?? []}>
              {(spike) => (
                <circle
                  data-testid="diagnostics-spike"
                  data-metric={spike.metric}
                  data-attributed={spike.context ? "true" : "false"}
                  cx={x(spike.at)}
                  cy={y(Math.min(spike.value, axisFor(spike.metric).top), axisFor(spike.metric).top)}
                  r="3.5"
                  fill={spike.context ? "var(--icon-critical-base)" : "var(--background-base)"}
                  stroke="var(--icon-critical-base)"
                  stroke-width="1.5"
                >
                  <title>{spikeTitle(spike)}</title>
                </circle>
              )}
            </For>

            {/* Sample markers for the hovered instant, one per series. */}
            <Show when={hovered()}>
              {(point) => (
                <>
                  <Show when={point().memoryImpactBytes !== undefined}>
                    <circle
                      cx={x(point().at)}
                      cy={y(point().memoryImpactBytes!, memoryAxis().top)}
                      r="3"
                      fill="var(--icon-provider-claude-base)"
                      stroke="var(--background-base)"
                      stroke-width="1.5"
                    />
                  </Show>
                  <Show when={point().cpu !== undefined}>
                    <circle
                      cx={x(point().at)}
                      cy={y(point().cpu!, cpuAxis().top)}
                      r="3"
                      fill="var(--text-strong)"
                      stroke="var(--background-base)"
                      stroke-width="1.5"
                    />
                  </Show>
                </>
              )}
            </Show>

            {/* Value labels: CPU reads off the left axis, memory impact off the right. */}
            <For each={cpuAxis().values}>
              {(value) => (
                <text
                  x={plotLeft - 8}
                  y={y(value, cpuAxis().top) + 3.5}
                  text-anchor="end"
                  font-size="10"
                  fill="var(--text-weak)"
                >
                  {cpuAxis().format(value)}
                </text>
              )}
            </For>
            <For each={memoryAxis().values}>
              {(value) => (
                <text
                  x={plotRight() + 8}
                  y={y(value, memoryAxis().top) + 3.5}
                  text-anchor="start"
                  font-size="10"
                  fill="var(--text-weak)"
                >
                  {memoryAxis().format(value)}
                </text>
              )}
            </For>
            <For each={xTicks()}>
              {(at, index) => (
                <text
                  x={x(at)}
                  y={PLOT_BOTTOM + 15}
                  text-anchor={index() === 0 ? "start" : index() === X_TICKS ? "end" : "middle"}
                  font-size="10"
                  fill="var(--text-weak)"
                >
                  {formatTime(at)}
                </text>
              )}
            </For>

            {/* Axis captions double as the legend: each unit is drawn in its series colour. */}
            <text x={plotLeft - 8} y={PLOT_TOP - 10} text-anchor="end" font-size="10" fill="var(--text-strong)">
              CPU
            </text>
            <text
              x={plotRight() + 8}
              y={PLOT_TOP - 10}
              text-anchor="start"
              font-size="10"
              fill="var(--icon-provider-claude-base)"
            >
              {memoryAxis().unit}
            </text>
          </svg>

          <Show when={hovered()}>
            {(point) => (
              <div
                data-testid="diagnostics-hover-readout"
                class="workspace-data-tooltip diagnostics-chart-tooltip"
                style={{
                  width: `${String(TOOLTIP_WIDTH)}px`,
                  left: `${String(tooltipLeft(x(point().at), width()))}px`,
                }}
              >
                <strong>{formatTime(point().at)}</strong>
                <div>
                  <span class="diagnostics-series diagnostics-series-cpu">
                    <i />
                    CPU
                  </span>
                  <b>{formatCpuValue(point().cpu)}</b>
                </div>
                <div>
                  <span class="diagnostics-series diagnostics-series-memory">
                    <i />
                    Memory impact
                  </span>
                  <b>
                    {formatRssValue(point().memoryImpactBytes)}
                    {point().memoryImpactComplete ? "" : " (partial)"}
                  </b>
                </div>
                <Show when={hoveredSpikes().length > 0}>
                  <div class="diagnostics-tooltip-attribution">
                    <For each={hoveredSpikes()}>
                      {(spike) => (
                        <div data-testid="diagnostics-hover-attribution" class="mt-1 first:mt-0">
                          <div class="flex items-center gap-1.5 text-text-base">
                            <span class="inline-block size-1.5 shrink-0 rounded-full bg-icon-critical-base" />
                            {{ cpu: "CPU", rss: "RSS", "memory-impact": "Memory impact" }[spike.metric]} spike{" "}
                            {formatSpikeDelta(spike)}
                          </div>
                          <Show
                            when={spike.context}
                            fallback={<div class="mt-0.5 pl-3 text-text-weak">No attribution captured</div>}
                          >
                            {(context) => (
                              <div class="mt-0.5 pl-3 text-text-weak">
                                {[
                                  context().screen,
                                  context().sessionId ? `session ${context().sessionId!}` : undefined,
                                  context().workspaceId ? `workspace ${context().workspaceId!}` : undefined,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </div>
                            )}
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            )}
          </Show>
        </div>
      </div>
    </section>
  )
}

/** Keeps the readout inside the chart box, flipping sides rather than overhanging. */
function tooltipLeft(pointerX: number, chartWidth: number) {
  return Math.max(4, Math.min(pointerX + 12, chartWidth - TOOLTIP_WIDTH - 4))
}

type ValueAxis = {
  top: number
  values: number[]
  unit: string
  format(value: number): string
}

/** The plotted maximum for a field, or 0 when the field was never sampled. */
function peak(points: DiagnosticsSeriesPoint[], field: "cpu" | "memoryImpactBytes") {
  return Math.max(0, ...points.flatMap((point) => (point[field] === undefined ? [] : [point[field]!])))
}

/** Rounds the observed peak up to a readable tick step so every gridline lands on a whole number. */
function niceAxis(observed: number, kind: "percent" | "bytes"): ValueAxis {
  const scale = kind === "bytes" ? binaryScale(observed) : { size: 1, unit: "%" }
  const step = niceStep(Math.max(observed, scale.size) / scale.size / Y_TICKS) * scale.size
  const top = step * Y_TICKS
  const decimals = step / scale.size >= 1 ? 0 : step / scale.size >= 0.1 ? 1 : 2
  return {
    top,
    values: Array.from({ length: Y_TICKS + 1 }, (_, index) => index * step),
    unit: scale.unit,
    format: (value) =>
      kind === "percent" ? `${(value / scale.size).toFixed(decimals)}%` : (value / scale.size).toFixed(decimals),
  }
}

function binaryScale(observed: number) {
  if (observed >= 1024 ** 3) return { size: 1024 ** 3, unit: "GiB" }
  if (observed >= 1024 ** 2) return { size: 1024 ** 2, unit: "MiB" }
  return { size: 1024, unit: "KiB" }
}

function niceStep(rough: number) {
  if (!(rough > 0)) return 1
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const normalized = rough / magnitude
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10
  return factor * magnitude
}

/** The chart's non-visual equivalent, for readers who cannot hover it. */
function chartLabel(
  bounds: DiagnosticsRange,
  cpu: ValueAxis,
  memory: ValueAxis,
  points: DiagnosticsSeriesPoint[],
  spikes: LocalDiagnostics.SpikeMarker[],
) {
  const attributed = spikes.filter((spike) => spike.context).length
  return [
    `CPU and memory timeline from ${formatTime(bounds.startAt)} to ${formatTime(bounds.endAt)}`,
    `CPU axis 0 to ${cpu.format(cpu.top)}, peak ${cpu.format(peak(points, "cpu"))}`,
    `Memory impact axis 0 to ${memory.format(memory.top)} ${memory.unit}, peak ${memory.format(peak(points, "memoryImpactBytes"))} ${memory.unit}`,
    `${String(spikes.length)} marked spikes, ${String(attributed)} attributed`,
  ].join(". ")
}

function spikeTitle(spike: LocalDiagnostics.SpikeMarker) {
  const value = spike.metric === "cpu" ? `${spike.value.toFixed(1)}%` : formatBytes(spike.value)
  return `${spike.metric.toUpperCase()} spike ${value} (${formatSpikeDelta(spike)})${spike.context ? ` on ${spike.context.screen}` : ""}`
}

function formatSpikeDelta(spike: LocalDiagnostics.SpikeMarker) {
  return spike.metric === "cpu" ? `+${spike.delta.toFixed(1)}%` : `+${formatBytes(spike.delta)}`
}

function formatCpuValue(value: number | undefined) {
  return value === undefined ? "Unavailable" : `${value.toFixed(value >= 10 ? 0 : 1)}%`
}

function formatRssValue(value: number | undefined) {
  return value === undefined ? "Unavailable" : formatBytes(value)
}

function formatBytes(value: number) {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`
  return `${(value / 1024).toFixed(0)} KiB`
}

export function formatTime(value: number) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

export function formatDuration(value: number) {
  if (value < 1_000) return `${String(value)} ms`
  if (value < 60_000) return `${(value / 1_000).toFixed(1)} s`
  return `${(value / 60_000).toFixed(1)} min`
}
