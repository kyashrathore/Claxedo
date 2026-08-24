import { Switch as Kobalte } from "@kobalte/core/switch"
import { Show, omit } from "solid-js"
import type { ParentProps } from "solid-js"
import type { ComponentProps } from "@solidjs/web"

export interface SwitchProps extends ParentProps<ComponentProps<typeof Kobalte>> {
  hideLabel?: boolean
  description?: string
}

export function Switch(props: SwitchProps) {
  const local = props,
    others = omit(props, "children", "class", "hideLabel", "description")
  return (
    <Kobalte {...others} class={local.class} data-component="switch">
      <Kobalte.Input data-slot="switch-input" />
      <Show when={local.children}>
        <Kobalte.Label data-slot="switch-label" class={{ "sr-only": !!local.hideLabel }}>
          {local.children}
        </Kobalte.Label>
      </Show>
      <Show when={local.description}>
        <Kobalte.Description data-slot="switch-description">{local.description}</Kobalte.Description>
      </Show>
      <Kobalte.ErrorMessage data-slot="switch-error" />
      <Kobalte.Control data-slot="switch-control">
        <Kobalte.Thumb data-slot="switch-thumb" />
      </Kobalte.Control>
    </Kobalte>
  )
}
