import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { axisLabelIndexes, niceCeiling, type DailyPoint } from "../daily-series"
import { usageDictionary } from "../i18n"
import { useUsageFormats } from "./usage-formats"

const MIN_BAR_PERCENT = 1.5

const STEP_KEYS: Readonly<Record<string, (index: number, last: number) => number>> = {
  ArrowLeft: (index) => Math.max(0, index - 1),
  ArrowRight: (index, last) => Math.min(last, index + 1),
  Home: () => 0,
  End: (_, last) => last,
}

export function DailyChart(props: { readonly points: readonly DailyPoint[]; readonly value: (value: number) => string }): JSX.Element {
  const t = useTranslator(usageDictionary)
  const format = useUsageFormats()
  const [active, setActive] = createSignal<number>()
  const ceiling = createMemo(() => niceCeiling(Math.max(0, ...props.points.map((point) => point.value ?? 0))))
  const labelled = createMemo(() => new Set(axisLabelIndexes(props.points.length)))
  const height = (value: number | null) => (value === null || value <= 0 || ceiling() === 0 ? 0 : Math.max(MIN_BAR_PERCENT, (value / ceiling()) * 100))
  const align = (index: number) => (index === 0 ? "start" : index === props.points.length - 1 ? "end" : "center")
  const readout = () => {
    const point = props.points[active() ?? -1]
    if (!point) return t("usage.daily")
    return t("usage.daily.day", { date: format.longDay(point.date), value: point.value === null ? t("usage.unknown") : props.value(point.value) })
  }
  const step = (event: KeyboardEvent) => {
    const move = STEP_KEYS[event.key]
    if (!move) return
    event.preventDefault()
    setActive(move(active() ?? props.points.length - 1, props.points.length - 1))
  }
  return (
    <figure class="usage-chart" data-dense={props.points.length > 31}>
      <figcaption class="usage-chart-readout" aria-live="polite">{readout()}</figcaption>
      <div class="usage-chart-frame">
        <div class="usage-chart-scale" aria-hidden="true">
          <For each={ceiling() > 0 ? [1, 0.5, 0] : [0]}>{(fraction) => <span style={{ bottom: `${fraction * 100}%` }}>{props.value(ceiling() * fraction)}</span>}</For>
        </div>
        <div class="usage-chart-plot" role="group" tabindex="0" aria-label={t("usage.daily")} onKeyDown={step} onPointerLeave={() => setActive(undefined)} onBlur={() => setActive(undefined)}>
          <For each={props.points}>
            {(point, index) => (
              <div class="usage-chart-day" data-active={active() === index()} onPointerEnter={() => setActive(index())} onPointerDown={() => setActive(index())}>
                <i class="usage-chart-bar" data-unknown={point.value === null} style={{ height: `${height(point.value)}%` }} />
              </div>
            )}
          </For>
        </div>
        <div class="usage-chart-axis" aria-hidden="true">
          <For each={props.points}>
            {(point, index) => (
              <span class="usage-chart-tick" data-align={align(index())}>
                <Show when={labelled().has(index())}>{format.day(point.date, props.points.length)}</Show>
              </span>
            )}
          </For>
        </div>
      </div>
    </figure>
  )
}
