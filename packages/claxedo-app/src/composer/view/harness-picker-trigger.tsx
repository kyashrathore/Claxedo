import { Show, type Accessor, type JSX } from "solid-js"
import { Popover as Kobalte } from "@kobalte/core/popover"
import { ClaxedoIcon as Icon, Button } from "@/ui"
import type { HarnessSectionProps } from "./harness-picker-harness-section"
import type { ModelSectionProps } from "./harness-picker-model-section"
import type { EffortControlProps } from "./harness-picker-effort-row"

export type TriggerProps = {
  triggerStyle?: Accessor<JSX.CSSProperties>
  triggerLabel?: string
  triggerHint?: Accessor<string | undefined>
  triggerState?: Accessor<{
    harness: string
    model?: string
    provider?: string
    readiness: string
    readyForSubmit: boolean
  }>
}

export function HarnessPickerTrigger<H>(props: {
  picker: TriggerProps &
    Pick<HarnessSectionProps<H>, "harness" | "harnessIcon" | "harnessDisabled"> &
    Pick<ModelSectionProps, "modelLabel" | "modelDisabled"> &
    Pick<EffortControlProps, "showEffort" | "fast">
  effortInTrigger: Accessor<string | undefined>
}) {
  return (
    <Kobalte.Trigger
      as={Button}
      variant="ghost"
      size="normal"
      style={props.picker.triggerStyle?.()}
      disabled={props.picker.modelDisabled() && props.picker.harnessDisabled()}
      aria-label={props.picker.triggerLabel ?? "Select harness, model and effort"}
      title={props.picker.triggerHint?.()}
      data-action="prompt-harness-model"
      data-harness={props.picker.triggerState?.().harness}
      data-model={props.picker.triggerState?.().model}
      data-provider={props.picker.triggerState?.().provider}
      data-readiness={props.picker.triggerState?.().readiness}
      data-ready-for-submit={props.picker.triggerState?.().readyForSubmit ? "true" : "false"}
      class="composer-harness-model group min-w-0 max-w-[260px] max-md:max-w-[132px] text-13-regular"
    >
      <span class="flex shrink-0 items-center">{props.picker.harnessIcon(props.picker.harness())}</span>
      <span data-slot="composer-control-label" class="truncate">{props.picker.modelLabel()}</span>
      <Show when={props.picker.showEffort() && props.effortInTrigger()}>
        <span class="shrink-0 text-v2-text-text-faint">{props.effortInTrigger()}</span>
      </Show>
      <Show when={props.picker.fast?.()?.on}>
        <Icon name="bolt" size="small" aria-label={props.picker.fast?.()?.label} class="shrink-0 text-v2-text-text-faint" />
      </Show>
      <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
    </Kobalte.Trigger>
  )
}
