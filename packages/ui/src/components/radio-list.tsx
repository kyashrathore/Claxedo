import { RadioGroup as KobalteRadio } from "@kobalte/core/radio-group"
import { Show, splitProps } from "solid-js"
import type { ComponentProps, JSX, ParentProps } from "solid-js"

/**
 * A list of choices, one row each: a control, a label, an optional second line,
 * and trailing controls of the caller's own. Its rows differ in width and in
 * height, which is what separates it from the segmented `RadioGroup` beside it.
 */

export type RadioListProps = ParentProps<ComponentProps<typeof KobalteRadio>>

/** A vertical list of choices, one row each, with the rows free to differ in width. */
export function RadioList(props: RadioListProps) {
  const [local, others] = splitProps(props, ["children", "class", "classList"])
  return (
    <KobalteRadio
      {...others}
      data-component="radio-list"
      classList={{
        "ui-radio-list": true,
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      {local.children}
    </KobalteRadio>
  )
}

export type RadioListItemProps = ComponentProps<typeof KobalteRadio.Item> & {
  label: JSX.Element
  /** A second line under the label, for whatever the label alone does not say. */
  description?: JSX.Element
  /** Rings the control in the danger token: the value is stored but unusable. */
  invalid?: boolean
  /** Trailing controls; they sit outside the label, so pressing one does not select the row. */
  children?: JSX.Element
}

export function RadioListItem(props: RadioListItemProps) {
  const [local, others] = splitProps(props, ["children", "class", "classList", "label", "description", "invalid"])
  return (
    <KobalteRadio.Item
      {...others}
      data-slot="radio-list-item"
      data-invalid={local.invalid ? "" : undefined}
      classList={{
        "ui-radio-list-item": true,
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <KobalteRadio.ItemInput data-slot="radio-list-item-input" />
      <KobalteRadio.ItemControl data-slot="radio-list-item-control" class="ui-radio-list-item-control">
        <KobalteRadio.ItemIndicator data-slot="radio-list-item-indicator" class="ui-radio-list-item-indicator" />
      </KobalteRadio.ItemControl>
      <div data-slot="radio-list-item-text" class="ui-radio-list-item-text">
        <KobalteRadio.ItemLabel data-slot="radio-list-item-label" class="ui-radio-list-item-label">
          {local.label}
        </KobalteRadio.ItemLabel>
        <Show when={local.description}>
          {(description) => (
            <KobalteRadio.ItemDescription data-slot="radio-list-item-description" class="ui-radio-list-item-description">
              {description()}
            </KobalteRadio.ItemDescription>
          )}
        </Show>
      </div>
      {local.children}
    </KobalteRadio.Item>
  )
}
