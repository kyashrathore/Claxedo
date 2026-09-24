import { RadioGroup as Kobalte } from "@kobalte/core/radio-group"
import { Show, splitProps, type JSX } from "solid-js"
import type { ComponentProps, ParentProps } from "solid-js"
import "./radio.css"

export interface RadioGroupProps extends ParentProps<ComponentProps<typeof Kobalte>> {
  label?: JSX.Element
  description?: JSX.Element
  hideLabel?: boolean
}

export function RadioGroup(props: RadioGroupProps) {
  const [local, others] = splitProps(props, ["class", "classList", "children", "label", "description", "hideLabel"])
  return (
    <Kobalte
      {...others}
      data-component="v2-radio"
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <Show when={local.label}>
        {(label) => (
          <Kobalte.Label data-slot="v2-radio-label" classList={{ "sr-only": local.hideLabel }}>
            {label()}
          </Kobalte.Label>
        )}
      </Show>
      <Show when={local.description}>
        {(description) => <Kobalte.Description data-slot="v2-radio-description">{description()}</Kobalte.Description>}
      </Show>
      <div data-slot="v2-radio-items">{local.children}</div>
      <Kobalte.ErrorMessage data-slot="v2-radio-error" class="v2-radio-error" />
    </Kobalte>
  )
}

export interface RadioItemProps extends ComponentProps<typeof Kobalte.Item> {
  label: JSX.Element
  description?: JSX.Element
  hideLabel?: boolean
}

export function RadioItem(props: RadioItemProps) {
  const [local, others] = splitProps(props, ["class", "classList", "label", "description", "hideLabel"])
  return (
    <Kobalte.Item
      {...others}
      data-slot="v2-radio-item"
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <Kobalte.ItemInput data-slot="v2-radio-item-input" />
      <div data-slot="v2-radio-item-control-stack">
        <Kobalte.ItemControl data-slot="v2-radio-item-control" class="v2-radio-item-control">
          <Kobalte.ItemIndicator data-slot="v2-radio-item-indicator" />
        </Kobalte.ItemControl>
      </div>
      <Kobalte.ItemLabel data-slot="v2-radio-item-label" classList={{ "sr-only": local.hideLabel }}>
        <div data-slot="v2-radio-item-text">
          <span data-slot="v2-radio-item-label-text" class="v2-radio-item-label-text">{local.label}</span>
          <Show when={local.description}>
            {(description) => <span data-slot="v2-radio-item-description" class="v2-radio-item-description">{description()}</span>}
          </Show>
        </div>
      </Kobalte.ItemLabel>
    </Kobalte.Item>
  )
}
