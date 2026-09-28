import { For, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { SegmentedControl, SegmentedControlItem } from "@/ui"
import { usageDictionary, type UsageKey } from "../i18n"

export type Choice<Value extends string> = { readonly value: Value; readonly label: UsageKey }

export function Choices<Value extends string>(props: {
  readonly label: string
  readonly choices: readonly Choice<Value>[]
  readonly value: Value
  readonly onChange: (value: Value) => void
}): JSX.Element {
  const t = useTranslator(usageDictionary)
  const pick = (value: string | null) => props.choices.find((choice) => choice.value === value)?.value
  return (
    <SegmentedControl
      class="segmented-control-v2--fit"
      aria-label={props.label}
      value={props.value}
      onChange={(value) => {
        const next = pick(value)
        if (next) props.onChange(next)
      }}
    >
      <For each={props.choices}>{(choice) => <SegmentedControlItem value={choice.value}>{t(choice.label)}</SegmentedControlItem>}</For>
    </SegmentedControl>
  )
}
