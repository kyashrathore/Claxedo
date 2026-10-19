import { createMemo, Match, Switch as Branch } from "solid-js"
import { Checkbox, Field, Switch, Textarea, TextField } from "@/ui"
import { boundBoolean, boundText, createBoundValue } from "../binding"
import type { SurfaceNodeProps } from "../model"
import { isSubmitKey } from "../submit-key"
import { validationPattern } from "../validation"
import { useSurfaceReader, useSurfaceRuntime } from "./surface-runtime"

type TextVariant = NonNullable<SurfaceNodeProps<"TextField">["def"]["variant"]>

const INPUT_TYPES: Record<TextVariant, "number" | "password" | "text"> = { number: "number", obscured: "password", shortText: "text", longText: "text" }

export function TextFieldView(props: SurfaceNodeProps<"TextField">) {
  const runtime = useSurfaceRuntime()
  const read = useSurfaceReader()
  const field = createBoundValue(() => props.def.value, () => props.scope, runtime.state.data, boundText)
  const pattern = createMemo(() => validationPattern(props.def.validationRegexp))
  const invalid = () => {
    const current = pattern()
    return current !== undefined && field.value() !== "" && !current.test(field.value())
  }
  const label = () => read.text(props.def.label, props.scope)
  const submitOnKey = (event: KeyboardEvent) => {
    if (props.def.submit === undefined || !isSubmitKey(event, props.def.variant === "longText")) return
    event.preventDefault()
    runtime.fire(props.def.submit, props.def.id, props.scope, { value: field.value() })
  }
  return (
    <Branch>
      <Match when={props.def.variant === "longText"}>
        <Field data-slot="surface-long-text" invalid={invalid()}>
          <Field.Label>{label()}</Field.Label>
          <Textarea invalid={invalid()} value={field.value()} onInput={(event) => field.set(event.currentTarget.value)} onKeyDown={submitOnKey} />
        </Field>
      </Match>
      <Match when={props.def.variant !== "longText"}>
        <TextField
          label={label()}
          type={INPUT_TYPES[props.def.variant ?? "shortText"]}
          invalid={invalid()}
          value={field.value()}
          onChange={field.set}
          onKeyDown={submitOnKey}
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
