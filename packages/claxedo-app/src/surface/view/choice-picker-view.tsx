import { createMemo, createUniqueId, For, Match, Show, Switch } from "solid-js"
import { Checkbox, RadioGroup, RadioItem, Select } from "@/ui"
import { boundTextList, createBoundValue } from "../binding"
import { surfaceIconName } from "../icon-names"
import type { SurfaceNodeProps } from "../model"
import { ChoiceMenu, type MenuChoice } from "./choice-menu"
import { SurfaceIcon } from "./surface-icon"
import { useSurfaceReader, useSurfaceRuntime } from "./surface-runtime"

type DisplayStyle = NonNullable<SurfaceNodeProps<"ChoicePicker">["def"]["displayStyle"]>

type ChoiceProps = {
  readonly label: string | undefined
  readonly choices: readonly MenuChoice[]
  readonly selected: readonly string[]
  readonly displayStyle: DisplayStyle
  readonly iconOnly: boolean
  readonly onChange: (values: string[]) => void
}

type ChipTogglesProps = {
  readonly label: string | undefined
  readonly choices: readonly MenuChoice[]
  readonly iconOnly: boolean
  readonly isOn: (value: string) => boolean
  readonly onToggle: (value: string) => void
}

function ChipToggles(props: ChipTogglesProps) {
  return (
    <div data-slot="surface-chips" data-icon-only={props.iconOnly ? "true" : "false"} role="group" aria-label={props.label}>
      <For each={props.choices}>
        {(choice) => (
          <button
            type="button"
            data-slot="surface-chip"
            aria-pressed={props.isOn(choice.value)}
            aria-label={props.iconOnly ? choice.label : undefined}
            title={props.iconOnly ? choice.label : undefined}
            onClick={() => props.onToggle(choice.value)}
          >
            <Show when={choice.icon}>{(icon) => <SurfaceIcon name={icon()} size="small" />}</Show>
            <Show when={!props.iconOnly}>{choice.label}</Show>
          </button>
        )}
      </For>
    </div>
  )
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
        <ChipToggles label={props.label} choices={props.choices} iconOnly={props.iconOnly} isOn={(value) => current() === value} onToggle={(value) => props.onChange([value])} />
      </Match>
      <Match when={props.displayStyle === "menu"}>
        <ChoiceMenu label={props.label} choices={props.choices} current={current()} iconOnly={props.iconOnly} onPick={(value) => props.onChange([value])} />
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
      <ChipToggles label={props.label} choices={props.choices} iconOnly={props.iconOnly} isOn={isOn} onToggle={(value) => toggle(value, !isOn(value))} />
    </Show>
  )
}

export function ChoicePickerView(props: SurfaceNodeProps<"ChoicePicker">) {
  const runtime = useSurfaceRuntime()
  const read = useSurfaceReader()
  const field = createBoundValue(() => props.def.value, () => props.scope, runtime.state.data, boundTextList)
  const choices = createMemo(() => props.def.options.map((option) => ({ value: option.value, label: read.text(option.label, props.scope), icon: surfaceIconName(option.icon) })))
  const label = () => (props.def.label === undefined ? undefined : read.text(props.def.label, props.scope))
  const displayStyle = () => props.def.displayStyle ?? "checkbox"
  const exclusive = () => props.def.variant !== "multipleSelection"
  const labelId = createUniqueId()
  const iconOnly = () => props.def.iconOnly === true
  const ownLabel = () => (exclusive() && (displayStyle() === "checkbox" || displayStyle() === "menu") ? undefined : iconOnly() ? undefined : label())
  const change = (values: string[]) => {
    field.set(values)
    runtime.fire(props.def.change, props.def.id, props.scope, { value: values })
  }
  return (
    <div data-slot="surface-choice" data-display={displayStyle()} role="group" aria-labelledby={ownLabel() ? labelId : undefined} aria-label={ownLabel() ? undefined : label()}>
      <Show when={ownLabel()}>
        {(text) => (
          <span id={labelId} data-slot="surface-input-label">
            {text()}
          </span>
        )}
      </Show>
      <Show
        when={!exclusive()}
        fallback={<ExclusiveChoice label={label()} choices={choices()} selected={field.value()} displayStyle={displayStyle()} iconOnly={iconOnly()} onChange={change} />}
      >
        <MultipleChoice label={label()} choices={choices()} selected={field.value()} displayStyle={displayStyle()} iconOnly={iconOnly()} onChange={change} />
      </Show>
    </div>
  )
}
