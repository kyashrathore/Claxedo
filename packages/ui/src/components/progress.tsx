import { Progress as Kobalte } from "@kobalte/core/progress"
import { Show, omit } from "solid-js"
import type { ParentProps } from "solid-js"
import type { ComponentProps } from "@solidjs/web"

export interface ProgressProps extends ParentProps<ComponentProps<typeof Kobalte>> {
  hideLabel?: boolean
  showValueLabel?: boolean
}

export function Progress(props: ProgressProps) {
  const local = props,
    others = omit(props, "children", "class", "hideLabel", "showValueLabel")

  return (
    <Kobalte {...others} data-component="progress" class={local.class}>
      <Show when={local.children || local.showValueLabel}>
        <div data-slot="progress-header">
          <Show when={local.children}>
            <Kobalte.Label data-slot="progress-label" class={{ "sr-only": !!local.hideLabel }}>
              {local.children}
            </Kobalte.Label>
          </Show>
          <Show when={local.showValueLabel}>
            <Kobalte.ValueLabel data-slot="progress-value-label" />
          </Show>
        </div>
      </Show>
      <Kobalte.Track data-slot="progress-track">
        <Kobalte.Fill data-slot="progress-fill" />
      </Kobalte.Track>
    </Kobalte>
  )
}
