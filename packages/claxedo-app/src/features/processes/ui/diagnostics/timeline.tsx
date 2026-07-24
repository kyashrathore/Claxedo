import { For, Show, createMemo, type JSX } from "solid-js"

import type { DiagnosticsRange, DiagnosticsSeriesPoint } from "./model"

export function DiagnosticsTimeline(props: {
  points: DiagnosticsSeriesPoint[]
  bounds: DiagnosticsRange
  range: DiagnosticsRange
  live: boolean
  onRangeChange(range: DiagnosticsRange): void
  onClear(): void
}) {
  const width = 800
  const height = 190
  const pad = 24
  const innerWidth = width - pad * 2
  const x = (at: number) =>
    pad + ((at - props.bounds.startAt) / Math.max(1, props.bounds.endAt - props.bounds.startAt)) * innerWidth
  const cpuMax = createMemo(() => Math.max(1, ...props.points.flatMap((point) => point.cpu === undefined ? [] : [point.cpu])))
  const rssMax = createMemo(() =>
    Math.max(1, ...props.points.flatMap((point) => point.rssBytes === undefined ? [] : [point.rssBytes])))
  const path = (field: "cpu" | "rssBytes", max: number) =>
    props.points
      .filter((point) => point[field] !== undefined)
      .map((point) => `${x(point.at)},${height - pad - (point[field]! / max) * (height - pad * 2)}`)
      .join(" ")

  let pointerStart: number | undefined
  const pointerAt = (event: PointerEvent & { currentTarget: SVGSVGElement }) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)))
    return Math.round(props.bounds.startAt + ratio * (props.bounds.endAt - props.bounds.startAt))
  }

  const updateHandle = (side: "startAt" | "endAt", event: InputEvent & { currentTarget: HTMLInputElement }) => {
    const value = Number(event.currentTarget.value)
    props.onRangeChange(
      side === "startAt"
        ? { startAt: Math.min(value, props.range.endAt), endAt: props.range.endAt }
        : { startAt: props.range.startAt, endAt: Math.max(value, props.range.startAt) },
    )
  }
  const moveHandle = (
    side: "startAt" | "endAt",
    event: KeyboardEvent & { currentTarget: HTMLInputElement },
  ) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    event.preventDefault()
    const values = [...new Set(props.points.map((point) => point.at))].sort((a, b) => a - b)
    if (values.length === 0) return
    const current = side === "startAt" ? props.range.startAt : props.range.endAt
    const index = values.reduce(
      (best, value, at) => Math.abs(value - current) < Math.abs(values[best]! - current) ? at : best,
      0,
    )
    const direction = event.key === "ArrowRight" ? 1 : -1
    const value = values[Math.max(0, Math.min(values.length - 1, index + direction * (event.shiftKey ? 5 : 1)))]!
    props.onRangeChange(
      side === "startAt"
        ? { startAt: Math.min(value, props.range.endAt), endAt: props.range.endAt }
        : { startAt: props.range.startAt, endAt: Math.max(value, props.range.startAt) },
    )
  }

  return (
    <section aria-labelledby="diagnostics-timeline-title" class="rounded-lg border border-border-weak-base bg-surface-raised-base p-3">
      <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="diagnostics-timeline-title" class="text-[13px] font-medium text-text-strong">CPU and memory history</h2>
          <p class="mt-0.5 text-[11px] text-text-weak">
            Drag across the chart or use the named handles. Arrow keys move one sample; Shift+Arrow moves five.
          </p>
        </div>
        <Show when={!props.live}>
          <button type="button" class="rounded px-2 py-1 text-[12px] text-text-base hover:bg-surface-base-hover" onClick={props.onClear}>
            Return to live window
          </button>
        </Show>
      </div>
      <svg
        viewBox={`0 0 ${String(width)} ${String(height)}`}
        class="h-[190px] w-full touch-none rounded bg-surface-base"
        role="img"
        aria-label={`CPU and memory timeline from ${formatTime(props.bounds.startAt)} to ${formatTime(props.bounds.endAt)}`}
        onPointerDown={(event) => {
          pointerStart = pointerAt(event)
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerUp={(event) => {
          if (pointerStart === undefined) return
          const end = pointerAt(event)
          props.onRangeChange({
            startAt: Math.min(pointerStart, end),
            endAt: Math.max(pointerStart, end),
          })
          pointerStart = undefined
        }}
      >
        <For each={[0.25, 0.5, 0.75]}>
          {(ratio) => <line x1={pad} x2={width - pad} y1={height * ratio} y2={height * ratio} stroke="var(--border-weak-base)" stroke-width="1" />}
        </For>
        <polyline points={path("rssBytes", rssMax())} fill="none" stroke="var(--icon-interactive-base)" stroke-width="3" vector-effect="non-scaling-stroke" />
        <polyline points={path("cpu", cpuMax())} fill="none" stroke="var(--icon-warning-base)" stroke-width="3" vector-effect="non-scaling-stroke" />
        <Show when={!props.live}>
          <rect
            x={x(props.range.startAt)}
            y={0}
            width={Math.max(2, x(props.range.endAt) - x(props.range.startAt))}
            height={height}
            fill="var(--surface-accent-base)"
            opacity="0.14"
          />
        </Show>
      </svg>
      <div class="mt-2 flex items-center gap-4 text-[11px] text-text-weak" aria-hidden="true">
        <span><span class="mr-1 inline-block h-0.5 w-4 bg-icon-warning-base" />CPU</span>
        <span><span class="mr-1 inline-block h-0.5 w-4 bg-icon-interactive-base" />RSS</span>
      </div>
      <div class="mt-3 grid grid-cols-2 gap-3">
        <RangeHandle
          label="Selection start"
          value={props.range.startAt}
          min={props.bounds.startAt}
          max={props.bounds.endAt}
          onInput={(event) => updateHandle("startAt", event)}
          onKeyDown={(event) => moveHandle("startAt", event)}
        />
        <RangeHandle
          label="Selection end"
          value={props.range.endAt}
          min={props.bounds.startAt}
          max={props.bounds.endAt}
          onInput={(event) => updateHandle("endAt", event)}
          onKeyDown={(event) => moveHandle("endAt", event)}
        />
      </div>
      <p class="mt-2 text-[12px] text-text-base">
        Selected {formatTime(props.range.startAt)} – {formatTime(props.range.endAt)} ({formatDuration(props.range.endAt - props.range.startAt)})
      </p>
    </section>
  )
}

function RangeHandle(props: {
  label: string
  value: number
  min: number
  max: number
  onInput: JSX.EventHandler<HTMLInputElement, InputEvent>
  onKeyDown: JSX.EventHandler<HTMLInputElement, KeyboardEvent>
}) {
  return (
    <label class="flex min-w-0 flex-col gap-1 text-[11px] text-text-weak">
      <span>{props.label}: {formatTime(props.value)}</span>
      <input
        aria-label={props.label}
        type="range"
        min={props.min}
        max={props.max}
        value={props.value}
        step={1}
        onInput={props.onInput}
        onKeyDown={props.onKeyDown}
        class="w-full"
      />
    </label>
  )
}

export function formatTime(value: number) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

export function formatDuration(value: number) {
  if (value < 1_000) return `${String(value)} ms`
  if (value < 60_000) return `${(value / 1_000).toFixed(1)} s`
  return `${(value / 60_000).toFixed(1)} min`
}
