import { Show, type Accessor } from "solid-js"
import { ClaxedoIcon as Icon } from "@/ui"
import { EffortSlider } from "./effort-slider"

export type FastModeControl = {
  on: boolean
  label: string
  description?: string
}

export type EffortControlProps = {
  showEffort: Accessor<boolean>
  variants: Accessor<string[]>
  currentVariant: Accessor<string | undefined>
  variantLabel: (value: string) => string
  onVariantSelect: (value: string) => void
  fast?: Accessor<FastModeControl | undefined>
  onFastToggle?: (next: boolean) => void
}

export function EffortRow(props: {
  levels: string[]
  current: string
  label: (value: string) => string
  onSelect: (value: string) => void
  fast?: FastModeControl
  onFastToggle: (next: boolean) => void
}) {
  return (
    <Show when={props.levels.length > 1 || props.fast}>
      <div class="flex flex-col gap-1">
        <Show when={props.levels.length > 1}>
          <div class="flex items-baseline justify-between gap-2 px-2.5 pt-1 text-compact">
            <span class="font-medium text-text-base">Effort</span>
            <span class="text-text-weak">{props.label(props.current)}</span>
          </div>
        </Show>
        <div class="harness-picker-effort-row" data-fast={props.fast ? "true" : undefined}>
          <Show when={props.levels.length > 1}>
            <EffortSlider levels={props.levels} current={props.current} label={props.label} onSelect={props.onSelect} />
          </Show>
          <Show when={props.fast}>
            {(fast) => (
              <button
                type="button"
                aria-pressed={fast().on}
                aria-label={fast().label}
                title={fast().description ? `${fast().label} · ${fast().description}` : fast().label}
                class="harness-picker-fast"
                onClick={() => props.onFastToggle(!fast().on)}
              >
                <Icon name="bolt" size="small" />
              </button>
            )}
          </Show>
        </div>
      </div>
    </Show>
  )
}
