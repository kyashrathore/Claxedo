import { createMemo, For, Match, Show, Switch } from "solid-js"
import { Checkbox, RadioGroup, RadioItem, SegmentedControl, SegmentedControlItem, Select } from "@/ui"
import { boundTextList, createBoundValue } from "../binding"
import type { SurfaceNodeProps } from "../model"
import { useSurfaceReader, useSurfaceRuntime } from "./surface-runtime"

type DisplayStyle = NonNullable<SurfaceNodeProps<"ChoicePicker">["def"]["displayStyle"]>

type Choice = { readonly value: string; readonly label: string }

type ChoiceProps = {
  readonly label: string | undefined
  readonly choices: readonly Choice[]
  readonly selected: readonly string[]
  readonly displayStyle: DisplayStyle
  readonly onChange: (values: string[]) => void
}

function ExclusiveChoice(props: ChoiceProps) {
  const current = () => props.selected[0]
  return (
    <Switch>
      <Match when={props.displayStyle === "dropdown"}>
        <Select
          options={[...props.choices]}
          current={props.choices.find((choice) => choice.value === current())}
          value={(choice) => choice.value}
          label={(choice) => choice.label}
          triggerProps={{ "aria-label": props.label }}
          onSelect={(choice) => props.onChange(choice ? [choice.value] : [])}
        />
      </Match>
      <Match when={props.displayStyle === "chips"}>
        <SegmentedControl aria-label={props.label} value={current() ?? null} onChange={(value) => props.onChange(value === null ? [] : [value])}>
          <For each={props.choices}>{(choice) => <SegmentedControlItem value={choice.value}>{choice.label}</SegmentedControlItem>}</For>
        </SegmentedControl>
      </Match>
      <Match when={props.displayStyle === "checkbox"}>
        <RadioGroup label={props.label} value={current() ?? ""} onChange={(value) => props.onChange([value])}>
          <For each={props.choices}>{(choice) => <RadioItem value={choice.value} label={choice.label} />}</For>
        </RadioGroup>
      </Match>
    </Switch>
  )
}

function MultipleChoice(props: ChoiceProps) {
  const isOn = (value: string) => props.selected.includes(value)
  const toggle = (value: string, on: boolean) =>
    props.onChange(on ? [...props.selected.filter((item) => item !== value), value] : props.selected.filter((item) => item !== value))
  return (
    <Show
      when={props.displayStyle === "chips"}
      fallback={
        <For each={props.choices}>{(choice) => <Checkbox label={choice.label} checked={isOn(choice.value)} onChange={(on: boolean) => toggle(choice.value, on)} />}</For>
      }
    >
      <div data-slot="surface-chips">
        <For each={props.choices}>
          {(choice) => (
            <button type="button" data-slot="surface-chip" aria-pressed={isOn(choice.value)} onClick={() => toggle(choice.value, !isOn(choice.value))}>
              {choice.label}
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}

export function ChoicePickerView(props: SurfaceNodeProps<"ChoicePicker">) {
  const runtime = useSurfaceRuntime()
  const read = useSurfaceReader()
  const field = createBoundValue(() => props.def.value, () => props.scope, runtime.state.data, boundTextList)
  const choices = createMemo(() => props.def.options.map((option) => ({ value: option.value, label: read.text(option.label, props.scope) })))
  const label = () => (props.def.label === undefined ? undefined : read.text(props.def.label, props.scope))
  const displayStyle = () => props.def.displayStyle ?? "checkbox"
  return (
    <fieldset data-slot="surface-choice">
      <Show
        when={props.def.variant === "multipleSelection"}
        fallback={<ExclusiveChoice label={label()} choices={choices()} selected={field.value()} displayStyle={displayStyle()} onChange={field.set} />}
      >
        <Show when={label()}>{(text) => <legend data-slot="surface-input-label">{text()}</legend>}</Show>
        <MultipleChoice label={label()} choices={choices()} selected={field.value()} displayStyle={displayStyle()} onChange={field.set} />
      </Show>
    </fieldset>
  )
}
