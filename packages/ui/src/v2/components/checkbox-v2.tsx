import { Checkbox as Kobalte } from "@kobalte/core/checkbox"
import { Show, omit } from "solid-js"
import type { JSX } from "@solidjs/web"
import type { ComponentProps } from "@solidjs/web"
import "./checkbox-v2.css"

export interface CheckboxV2Props extends ComponentProps<typeof Kobalte> {
  label: JSX.Element
  description?: JSX.Element
  hideLabel?: boolean
}

export function CheckboxV2(props: CheckboxV2Props) {
  const local = props,
    others = omit(props, "class", "label", "description", "hideLabel")
  return (
    <Kobalte {...others} data-slot="checkbox-v2" class={local.class}>
      <div data-slot="checkbox-v2-row">
        <Kobalte.Input data-slot="checkbox-v2-input" />
        <div data-slot="checkbox-v2-control-stack">
          <Kobalte.Control data-slot="checkbox-v2-control" class="ui-checkbox-v2-control">
            <Kobalte.Indicator data-slot="checkbox-v2-indicator">
              <svg
                class="checkbox-v2-icon checkbox-v2-icon--check"
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <path d="M3.53564 8.17857L6.39279 11.75L12.4642 4.25" stroke="#FAFAFA" stroke-width="1" />
              </svg>
              <svg
                class="checkbox-v2-icon checkbox-v2-icon--minus"
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <path d="M12.75 8H3.25" stroke="#FAFAFA" stroke-linejoin="round" stroke-width="1" />
              </svg>
            </Kobalte.Indicator>
          </Kobalte.Control>
        </div>
        <Kobalte.Label data-slot="checkbox-v2-label" class={["ui-checkbox-v2-label", { "sr-only": !!local.hideLabel }]}>
          <div data-slot="checkbox-v2-text">
            <span data-slot="checkbox-v2-label-text">{local.label}</span>
            <Show when={local.description}>
              {(description) => (
                <span data-slot="checkbox-v2-description" class="ui-checkbox-v2-description">
                  {description()}
                </span>
              )}
            </Show>
          </div>
        </Kobalte.Label>
      </div>
      <Kobalte.ErrorMessage data-slot="checkbox-v2-error" class="ui-checkbox-v2-error" />
    </Kobalte>
  )
}
