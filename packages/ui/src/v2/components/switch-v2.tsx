import { Switch as Kobalte } from "@kobalte/core/switch"
import { Show, omit } from "solid-js"
import type { ParentProps } from "solid-js"
import type { ComponentProps } from "@solidjs/web"
import "./switch-v2.css"

export interface SwitchProps extends ParentProps<ComponentProps<typeof Kobalte>> {
  hideLabel?: boolean
}

export function Switch(props: SwitchProps) {
  const local = props,
    others = omit(props, "children", "class", "hideLabel")
  return (
    <Kobalte {...others} class={local.class} data-component="switch">
      <Kobalte.Input data-slot="switch-input" />
      <Show when={local.children}>
        {(label) => (
          <Kobalte.Label data-slot="switch-label" class={{ "sr-only": !!local.hideLabel }}>
            {label()}
          </Kobalte.Label>
        )}
      </Show>
      <Kobalte.Control data-slot="switch-control">
        <Kobalte.Thumb data-slot="switch-thumb" />
      </Kobalte.Control>
      <Kobalte.ErrorMessage data-slot="switch-error" />
    </Kobalte>
  )
}
