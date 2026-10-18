import { createMemo, Match, Switch as Branch } from "solid-js"
import { Checkbox, Field, Switch, Textarea, TextField } from "@/ui"
import { boundBoolean, boundText, createBoundValue } from "../binding"
import type { SurfaceNodeProps } from "../model"
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
  return (
    <Branch>
      <Match when={props.def.variant === "longText"}>
        <Field data-slot="surface-long-text" invalid={invalid()}>
          <Field.Label>{label()}</Field.Label>
          <Textarea invalid={invalid()} value={field.value()} onInput={(event) => field.set(event.currentTarget.value)} />
        </Field>
      </Match>
      <Match when={props.def.variant !== "longText"}>
        <TextField
          label={label()}
          type={INPUT_TYPES[props.def.variant ?? "shortText"]}
          invalid={invalid()}
          value={field.value()}
          onChange={field.set}
        />
      </Match>
    </Branch>
  )
}

export function CheckBoxView(props: SurfaceNodeProps<"CheckBox">) {
  const runtime = useSurfaceRuntime()
  const read = useSurfaceReader()
  const field = createBoundValue(() => props.def.value, () => props.scope, runtime.state.data, boundBoolean)
  return <Checkbox label={read.text(props.def.label, props.scope)} checked={field.value()} onChange={field.set} />
}

export function SwitchView(props: SurfaceNodeProps<"Switch">) {
  const runtime = useSurfaceRuntime()
  const read = useSurfaceReader()
  const field = createBoundValue(() => props.def.value, () => props.scope, runtime.state.data, boundBoolean)
  return (
    <Switch checked={field.value()} onChange={field.set}>
      {read.text(props.def.label, props.scope)}
    </Switch>
  )
}
