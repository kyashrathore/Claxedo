import { createMemo, createSignal, For, Show, type Accessor, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useServer, type MachineClass } from "@/server"
import { Field, SegmentedControl, SegmentedControlItem } from "@/ui"
import { useCloudText } from "../i18n"

export type MachineSizeChoice = {
  readonly sizes: Accessor<readonly MachineClass[]>
  readonly chosen: Accessor<MachineClass | undefined>
  readonly choose: (size: MachineClass) => void
}

const SIZE_NAMES = { small: "cloud.size.small", default: "cloud.size.default", large: "cloud.size.large" } as const
const SIZE_DESCRIPTIONS = { small: "cloud.size.small.description", default: "cloud.size.default.description", large: "cloud.size.large.description" } as const

export function createMachineSizeChoice(): MachineSizeChoice {
  const server = useServer()
  const listing = useQuery(() => server.queries.accounts.sandbox())
  const sizes = createMemo(() => (listing.data?.kind === "listed" ? listing.data.machineClasses : []))
  const [picked, setPicked] = createSignal<MachineClass>("default")
  const chosen = () => (sizes().includes(picked()) ? picked() : sizes()[0])
  return { sizes, chosen, choose: setPicked }
}

export function MachineSizeField(props: { readonly choice: MachineSizeChoice }): JSX.Element {
  const t = useCloudText()
  const isSize = (value: string | null): value is MachineClass => props.choice.sizes().some((size) => size === value)
  return (
    <Show when={props.choice.chosen()}>
      {(size) => (
        <Field>
          <Field.Label>{t("cloud.size.label")}</Field.Label>
          <Field.Prefix>{t(SIZE_DESCRIPTIONS[size()])}</Field.Prefix>
          <SegmentedControl class="segmented-control-v2--fit" aria-label={t("cloud.size.label")} value={size()} onChange={(value) => isSize(value) && props.choice.choose(value)}>
            <For each={props.choice.sizes()}>{(option) => <SegmentedControlItem value={option}>{t(SIZE_NAMES[option])}</SegmentedControlItem>}</For>
          </SegmentedControl>
        </Field>
      )}
    </Show>
  )
}
