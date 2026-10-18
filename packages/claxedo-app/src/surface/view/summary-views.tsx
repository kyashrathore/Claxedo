import { Index, Show } from "solid-js"
import { Icon } from "@/ui"
import { boundText } from "../binding"
import { keyValueRows } from "../key-value"
import type { SurfaceNodeProps } from "../model"
import { CALLOUT_ICONS } from "../tones"
import { useSurfaceReader } from "./surface-runtime"

export function StatView(props: SurfaceNodeProps<"Stat">) {
  const read = useSurfaceReader()
  return (
    <div data-slot="surface-stat" data-tone={props.def.tone ?? "neutral"}>
      <span data-slot="surface-stat-label">{read.text(props.def.label, props.scope)}</span>
      <span data-slot="surface-stat-value">{read.text(props.def.value, props.scope)}</span>
      <Show when={read.text(props.def.delta, props.scope) || read.text(props.def.caption, props.scope)}>
        <div data-slot="surface-stat-foot">
          <Show when={read.text(props.def.delta, props.scope)}>{(delta) => <span data-slot="surface-stat-delta">{delta()}</span>}</Show>
          <Show when={read.text(props.def.caption, props.scope)}>{(caption) => <span data-slot="surface-stat-caption">{caption()}</span>}</Show>
        </div>
      </Show>
    </div>
  )
}

export function CalloutView(props: SurfaceNodeProps<"Callout">) {
  const read = useSurfaceReader()
  return (
    <div data-slot="surface-callout" data-tone={props.def.tone} role="note">
      <Icon name={CALLOUT_ICONS[props.def.tone]} size="small" data-slot="surface-callout-icon" />
      <div data-slot="surface-callout-text">
        <span data-slot="surface-callout-title">{read.text(props.def.title, props.scope)}</span>
        <Show when={read.text(props.def.text, props.scope)}>{(text) => <span data-slot="surface-callout-body">{text()}</span>}</Show>
      </div>
    </div>
  )
}

export function KeyValueView(props: SurfaceNodeProps<"KeyValue">) {
  const read = useSurfaceReader()
  const rows = () => keyValueRows(read.value(props.def.items, props.scope))
  const text = (value: unknown) => boundText(read.value(value, props.scope))
  return (
    <dl data-slot="surface-key-value">
      <Index each={rows()}>
        {(row) => (
          <div data-slot="surface-key-value-row">
            <dt>{text(row().label)}</dt>
            <dd>{text(row().value)}</dd>
          </div>
        )}
      </Index>
    </dl>
  )
}
