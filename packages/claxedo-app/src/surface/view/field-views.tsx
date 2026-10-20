import { createMemo, Match, Switch as Branch } from "solid-js"
import { Checkbox, Field, Switch, Textarea, TextField } from "@/ui"
import { boundBoolean, boundText, createBoundValue } from "../binding"
import type { SurfaceNodeProps } from "../model"
import type { SubmitKeys } from "../submit-key"
import { validationPattern } from "../validation"
import { InlineFieldView, TitleFieldView } from "./borderless-field-views"
import { createTextFieldEvents } from "./text-field-events"
import { useSurfaceReader, useSurfaceRuntime } from "./surface-runtime"

type TextVariant = NonNullable<SurfaceNodeProps<"TextField">["def"]["variant"]>

const INPUT_TYPES: Record<TextVariant, "number" | "password" | "text"> = { number: "number", obscured: "password", shortText: "text", longText: "text", title: "text", inline: "text" }

const SUBMIT_KEYS: Record<TextVariant, SubmitKeys> = { number: "line", obscured: "line", shortText: "line", longText: "text", title: "title", inline: "line" }

export function TextFieldView(props: SurfaceNodeProps<"TextField">) {
  const runtime = useSurfaceRuntime()
  const read = useSurfaceReader()
  const field = createBoundValue(() => props.def.value, () => props.scope, runtime.state.data, boundText)
  const variant = () => props.def.variant ?? "shortText"
  const events = createTextFieldEvents(runtime, field, () => ({ id: props.def.id, scope: props.scope, submit: props.def.submit, change: props.def.change, keys: SUBMIT_KEYS[variant()] }))
  const pattern = createMemo(() => validationPattern(props.def.validationRegexp))
  const invalid = () => {
    const current = pattern()
    return current !== undefined && field.value() !== "" && !current.test(field.value())
  }
  const label = () => read.text(props.def.label, props.scope)
  const placeholder = () => (props.def.placeholder === undefined ? undefined : read.text(props.def.placeholder, props.scope))
  const borderless = { label, placeholder, value: field.value, events }
  return (
    <Branch>
      <Match when={variant() === "title"}>
        <TitleFieldView {...borderless} />
      </Match>
      <Match when={variant() === "inline"}>
        <InlineFieldView {...borderless} />
      </Match>
      <Match when={variant() === "longText"}>
        <Field data-slot="surface-long-text" invalid={invalid()}>
          <Field.Label>{label()}</Field.Label>
          <Textarea invalid={invalid()} value={field.value()} placeholder={placeholder()} onInput={(event) => events.input(event.currentTarget.value)} onKeyDown={events.keyDown} onBlur={events.blur} />
        </Field>
      </Match>
      <Match when={true}>
        <TextField
          label={label()}
          type={INPUT_TYPES[variant()]}
          invalid={invalid()}
          value={field.value()}
          placeholder={placeholder()}
          onChange={events.input}
          onKeyDown={events.keyDown}
          onBlur={events.blur}
        />
      </Match>
    </Branch>
  )
}

export function CheckBoxView(props: SurfaceNodeProps<"CheckBox">) {
  const runtime = useSurfaceRuntime()
  const read = useSurfaceReader()
  const field = createBoundValue(() => props.def.value, () => props.scope, runtime.state.data, boundBoolean)
  const change = (checked: boolean) => {
    field.set(checked)
    runtime.fire(props.def.change, props.def.id, props.scope, { value: checked })
  }
  return <Checkbox label={read.text(props.def.label, props.scope)} checked={field.value()} onChange={change} />
}

export function SwitchView(props: SurfaceNodeProps<"Switch">) {
  const runtime = useSurfaceRuntime()
  const read = useSurfaceReader()
  const field = createBoundValue(() => props.def.value, () => props.scope, runtime.state.data, boundBoolean)
  const change = (checked: boolean) => {
    field.set(checked)
    runtime.fire(props.def.change, props.def.id, props.scope, { value: checked })
  }
  return (
    <Switch checked={field.value()} onChange={change}>
      {read.text(props.def.label, props.scope)}
    </Switch>
  )
}
