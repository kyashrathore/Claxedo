import { Switch as Kobalte } from "@kobalte/core/switch"
import { Show, splitProps } from "solid-js"
import type { ComponentProps, ParentProps } from "solid-js"
import "./switch.css"

export interface SwitchProps extends ParentProps<ComponentProps<typeof Kobalte>> {
  hideLabel?: boolean
}

export function Switch(props: SwitchProps) {
  const [local, others] = splitProps(props, ["children", "class", "hideLabel"])
  return (
    <Kobalte {...others} class={local.class} data-component="v2-switch">
      <Kobalte.Input data-slot="v2-switch-input" />
      <Show when={local.children}>
        {(label) => (
          <Kobalte.Label data-slot="v2-switch-label" classList={{ "sr-only": local.hideLabel }}>
            {label()}
          </Kobalte.Label>
        )}
      </Show>
      <Kobalte.Control data-slot="v2-switch-control" class="v2-switch-control">
        <Kobalte.Thumb data-slot="v2-switch-thumb" class="v2-switch-thumb" />
      </Kobalte.Control>
      <Kobalte.ErrorMessage data-slot="v2-switch-error" />
    </Kobalte>
  )
}
