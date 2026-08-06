import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"

import type { DiagnosticsRange, DiagnosticsSeriesPoint } from "./model"
import type { LocalDiagnostics } from "../../data/local-diagnostics"

/* The chart draws in CSS pixels: the viewBox tracks the measured element width so
   type renders at its authored size instead of being scaled by `preserveAspectRatio`.
   `FALLBACK_WIDTH` keeps the geometry deterministic before the first measurement
   (and under test runtimes without a ResizeObserver). */
const FALLBACK_WIDTH = 800
const HEIGHT = 232
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
  const measure = (element: HTMLDivElement) => {
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? 0
      if (measured > 0) setWidth(Math.round(measured))
    })
    observer.observe(element)
    onCleanup(() => observer.disconnect())
  }

  const plotLeft = PAD.left
  const plotRight = createMemo(() => Math.max(plotLeft + 1, width() - PAD.right))
  const span = createMemo(() => Math.max(1, props.bounds.endAt - props.bounds.startAt))
  const x = (at: number) =>
    plotLeft + ((at - props.bounds.startAt) / span()) * (plotRight() - plotLeft)
  const y = (value: number, top: number) =>
    PLOT_BOTTOM - (value / top) * (PLOT_BOTTOM - PLOT_TOP)

  const cpuAxis = createMemo(() => niceAxis(peak(props.points, "cpu"), "percent"))
  const rssAxis = createMemo(() => niceAxis(peak(props.points, "rssBytes"), "bytes"))
  const axisFor = (metric: LocalDiagnostics.SpikeMarker["metric"]) =>
    metric === "cpu" ? cpuAxis() : rssAxis()
  const points = (field: "cpu" | "rssBytes", top: number) =>
    props.points
      .filter((point) => point[field] !== undefined)
      .map((point) => `${String(x(point.at))},${String(y(point[field]!, top))}`)
      .join(" ")
  const xTicks = createMemo(() =>
    Array.from({ length: X_TICKS + 1 }, (_, index) =>
      props.bounds.startAt + (index / X_TICKS) * span()))

  /* Hover snaps to the nearest plotted sample so the readout always quotes a real
     measurement rather than an interpolated point on the trend line. */
  const hovered = createMemo(() => {
    const at = hoveredAt()
    if (at === undefined) return
    return props.points.reduce<DiagnosticsSeriesPoint | undefined>(
      (best, point) =>
        best === undefined || Math.abs(point.at - at) < Math.abs(best.at - at) ? point : best,
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
    const gaps = times.slice(1).map((time, index) => time - times[index]!).filter((gap) => gap > 0)
    return gaps.length > 0 ? Math.min(...gaps) : span()
  })

  const trackPointer = (event: PointerEvent & { currentTarget: SVGSVGElement }) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const local = ((event.clientX - rect.left) / Math.max(1, rect.width)) * width()
    const ratio = Math.max(0, Math.min(1, (local - plotLeft) / Math.max(1, plotRight() - plotLeft)))
    setHoveredAt(Math.round(props.bounds.startAt + ratio * span()))
  }

  return (
    <section aria-labelledby="diagnostics-timeline-title" class="rounded-lg border border-border-weak-base bg-surface-raised-base p-3">
      <div class="mb-2">
        <h2 id="diagnostics-timeline-title" class="text-[13px] font-medium text-text-strong">CPU and memory history</h2>
        <p class="mt-0.5 text-[11px] text-text-weak">
          Hover the chart to read a sample. Dots mark resource spikes; filled dots carry an attribution.
        </p>
      </div>
      <div ref={measure} class="relative rounded bg-surface-base">
        <svg
          viewBox={`0 0 ${String(width())} ${String(HEIGHT)}`}
          width={width()}
          height={HEIGHT}
          class="block h-[232px] w-full touch-none select-none [font-variant-numeric:tabular-nums]"
          role="img"
          aria-label={chartLabel(props.bounds, cpuAxis(), rssAxis(), props.points, props.spikes ?? [])}
          onPointerMove={trackPointer}
          onPointerLeave={() => setHoveredAt(undefined)}
        >
          {/* Horizontal grid — one band per tick, shared by both value axes. */}
          <For each={cpuAxis().values}>
            {(value) => (
              <line
                x1={plotLeft}
                x2={plotRight()}
                y1={y(value, cpuAxis().top)}
                y2={y(value, cpuAxis().top)}
                stroke="var(--border-base)"
                stroke-width="1"
                opacity="0.45"
                shape-rendering="crispEdges"
              />
            )}
          </For>
          {/* Vertical grid — interior time ticks only; the axes draw the edges. */}
          <For each={xTicks().slice(1, -1)}>
            {(at) => (
              <line
                x1={x(at)}
                x2={x(at)}
                y1={PLOT_TOP}
                y2={PLOT_BOTTOM}
                stroke="var(--border-base)"
                stroke-width="1"
                opacity="0.45"
                stroke-dasharray="2 4"
                shape-rendering="crispEdges"
              />
            )}
          </For>

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

          <polyline
            points={points("rssBytes", rssAxis().top)}
            fill="none"
            stroke="var(--icon-interactive-base)"
            stroke-width="2"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
          />
          <polyline
            points={points("cpu", cpuAxis().top)}
            fill="none"
            stroke="var(--icon-warning-base)"
            stroke-width="2"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
          />

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
                fill={spike.context ? "var(--icon-critical-base)" : "var(--surface-base)"}
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
                <Show when={point().rssBytes !== undefined}>
                  <circle
                    cx={x(point().at)}
                    cy={y(point().rssBytes!, rssAxis().top)}
                    r="3"
                    fill="var(--icon-interactive-base)"
                    stroke="var(--surface-base)"
                    stroke-width="1.5"
                  />
                </Show>
                <Show when={point().cpu !== undefined}>
                  <circle
                    cx={x(point().at)}
                    cy={y(point().cpu!, cpuAxis().top)}
                    r="3"
                    fill="var(--icon-warning-base)"
                    stroke="var(--surface-base)"
                    stroke-width="1.5"
                  />
                </Show>
              </>
            )}
          </Show>

          {/* Axis rules last so the plotted series never paint over them. */}
          <line
            x1={plotLeft}
            x2={plotRight()}
            y1={PLOT_BOTTOM}
            y2={PLOT_BOTTOM}
            stroke="var(--border-base)"
            stroke-width="1"
            shape-rendering="crispEdges"
          />
          <line
            x1={plotLeft}
            x2={plotLeft}
            y1={PLOT_TOP}
            y2={PLOT_BOTTOM}
            stroke="var(--border-base)"
            stroke-width="1"
            shape-rendering="crispEdges"
          />
          <line
            x1={plotRight()}
            x2={plotRight()}
            y1={PLOT_TOP}
            y2={PLOT_BOTTOM}
            stroke="var(--border-base)"
            stroke-width="1"
            shape-rendering="crispEdges"
          />
          {/* Value labels: CPU reads off the left axis, RSS off the right. */}
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
          <For each={rssAxis().values}>
            {(value) => (
              <text
                x={plotRight() + 8}
                y={y(value, rssAxis().top) + 3.5}
                text-anchor="start"
                font-size="10"
                fill="var(--text-weak)"
              >
                {rssAxis().format(value)}
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
          <text x={plotLeft - 8} y={PLOT_TOP - 10} text-anchor="end" font-size="10" fill="var(--icon-warning-base)">
            CPU
          </text>
          <text x={plotRight() + 8} y={PLOT_TOP - 10} text-anchor="start" font-size="10" fill="var(--icon-interactive-base)">
            {rssAxis().unit}
          </text>
        </svg>

        <Show when={hovered()}>
          {(point) => (
            <div
              data-testid="diagnostics-hover-readout"
              class="pointer-events-none absolute top-2 rounded-md border border-border-weak-base bg-surface-raised-stronger-non-alpha px-2.5 py-2 text-[11px] shadow-md-border-base"
              style={{ width: `${String(TOOLTIP_WIDTH)}px`, left: `${String(tooltipLeft(x(point().at), width()))}px` }}
            >
              <div class="font-medium tabular-nums text-text-strong">{formatTime(point().at)}</div>
              <dl class="mt-1.5 grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
                <dt class="flex items-center gap-1.5 text-text-weak">
                  <span class="inline-block size-1.5 rounded-full bg-icon-warning-base" />CPU
                </dt>
                <dd class="text-right tabular-nums text-text-base">{formatCpuValue(point().cpu)}</dd>
                <dt class="flex items-center gap-1.5 text-text-weak">
                  <span class="inline-block size-1.5 rounded-full bg-icon-interactive-base" />RSS
                </dt>
                <dd class="text-right tabular-nums text-text-base">{formatRssValue(point().rssBytes)}</dd>
              </dl>
              <Show when={hoveredSpikes().length > 0}>
                <div class="mt-2 border-t border-border-weak-base pt-1.5">
                  <For each={hoveredSpikes()}>
                    {(spike) => (
                      <div data-testid="diagnostics-hover-attribution" class="mt-1 first:mt-0">
                        <div class="flex items-center gap-1.5 text-text-base">
                          <span class="inline-block size-1.5 shrink-0 rounded-full bg-icon-critical-base" />
                          {spike.metric === "cpu" ? "CPU" : "RSS"} spike {formatSpikeDelta(spike)}
                        </div>
                        <Show when={spike.context} fallback={<div class="mt-0.5 pl-3 text-text-weak">No attribution captured</div>}>
                          {(context) => (
                            <div class="mt-0.5 pl-3 text-text-weak">
                              {[
                                context().screen,
                                context().sessionId ? `session ${context().sessionId!}` : undefined,
                                context().workspaceId ? `workspace ${context().workspaceId!}` : undefined,
                              ].filter(Boolean).join(" · ")}
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
function peak(points: DiagnosticsSeriesPoint[], field: "cpu" | "rssBytes") {
  return Math.max(0, ...points.flatMap((point) => point[field] === undefined ? [] : [point[field]!]))
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
      kind === "percent"
        ? `${(value / scale.size).toFixed(decimals)}%`
        : (value / scale.size).toFixed(decimals),
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
  rss: ValueAxis,
  points: DiagnosticsSeriesPoint[],
  spikes: LocalDiagnostics.SpikeMarker[],
) {
  const attributed = spikes.filter((spike) => spike.context).length
  return [
    `CPU and memory timeline from ${formatTime(bounds.startAt)} to ${formatTime(bounds.endAt)}`,
    `CPU axis 0 to ${cpu.format(cpu.top)}, peak ${cpu.format(peak(points, "cpu"))}`,
    `Memory axis 0 to ${rss.format(rss.top)} ${rss.unit}, peak ${rss.format(peak(points, "rssBytes"))} ${rss.unit}`,
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
