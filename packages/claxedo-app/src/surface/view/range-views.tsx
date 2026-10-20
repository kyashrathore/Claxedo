import { Show } from "solid-js"
import { boundNumber, boundText, createBoundValue } from "../binding"
import type { SurfaceNodeProps } from "../model"
import { rangeFillPercent } from "../range-fill"
import { useSurfaceReader, useSurfaceRuntime } from "./surface-runtime"

type DateInputType = "date" | "time" | "datetime-local"

function dateInputType(enableDate: boolean | undefined, enableTime: boolean | undefined): DateInputType {
  const date = enableDate ?? true
  const time = enableTime ?? false
  if (date && time) return "datetime-local"
  return time ? "time" : "date"
}

export function SliderView(props: SurfaceNodeProps<"Slider">) {
  const runtime = useSurfaceRuntime()
  const read = useSurfaceReader()
  const field = createBoundValue(() => props.def.value, () => props.scope, runtime.state.data, boundNumber)
  return (
    <label data-slot="surface-input">
      <Show when={props.def.label}>{(label) => <span data-slot="surface-input-label">{read.text(label(), props.scope)}</span>}</Show>
      <span data-slot="surface-slider-row">
        <input
          type="range"
          data-slot="surface-slider"
          style={{ "--surface-slider-fill": `${rangeFillPercent(field.value(), props.def.min ?? 0, props.def.max)}%` }}
          min={props.def.min ?? 0}
          max={props.def.max}
          step={props.def.step ?? 1}
          value={field.value()}
          onInput={(event) => field.set(event.currentTarget.valueAsNumber)}
        />
        <output>{field.value()}</output>
      </span>
    </label>
  )
}

export function DateTimeInputView(props: SurfaceNodeProps<"DateTimeInput">) {
  const runtime = useSurfaceRuntime()
  const read = useSurfaceReader()
  const field = createBoundValue(() => props.def.value, () => props.scope, runtime.state.data, boundText)
  const bound = (value: SurfaceNodeProps<"DateTimeInput">["def"]["min"]) => (value === undefined ? undefined : read.text(value, props.scope))
  return (
    <label data-slot="surface-input">
      <Show when={props.def.label}>{(label) => <span data-slot="surface-input-label">{read.text(label(), props.scope)}</span>}</Show>
      <input
        data-slot="surface-date-input"
        type={dateInputType(props.def.enableDate, props.def.enableTime)}
        min={bound(props.def.min)}
        max={bound(props.def.max)}
        value={field.value()}
        onInput={(event) => field.set(event.currentTarget.value)}
      />
    </label>
  )
}
