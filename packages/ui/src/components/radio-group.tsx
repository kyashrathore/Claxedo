import { RadioGroup as KobalteRadio } from "@kobalte/core/radio-group"
import { SegmentedControl as Kobalte } from "@kobalte/core/segmented-control"
import { For, splitProps } from "solid-js"
import type { ComponentProps, JSX, ParentProps } from "solid-js"

export type RadioGroupProps<T> = Omit<
  ComponentProps<typeof Kobalte>,
  "value" | "defaultValue" | "onChange" | "children"
> & {
  options: T[]
  current?: T
  defaultValue?: T
  value?: (x: T) => string
  label?: (x: T) => JSX.Element | string
  onSelect?: (value: T | undefined) => void
  class?: ComponentProps<"div">["class"]
  classList?: ComponentProps<"div">["classList"]
  size?: "small" | "medium"
  fill?: boolean
  pad?: "none" | "normal"
}

export function RadioGroup<T>(props: RadioGroupProps<T>) {
  const [local, others] = splitProps(props, [
    "class",
    "classList",
    "options",
    "current",
    "defaultValue",
    "value",
    "label",
    "onSelect",
    "size",
    "fill",
    "pad",
  ])

  const getValue = (item: T): string => {
    if (local.value) return local.value(item)
    return String(item)
  }

  const getLabel = (item: T): JSX.Element | string => {
    if (local.label) return local.label(item)
    return String(item)
  }

  const findOption = (v: string): T | undefined => {
    return local.options.find((opt) => getValue(opt) === v)
  }

  return (
    <Kobalte
      {...others}
      data-component="radio-group"
      data-size={local.size ?? "medium"}
      data-fill={local.fill ? "" : undefined}
      data-pad={local.pad ?? "normal"}
      classList={{
        "ui-radio-group": true,
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      value={local.current ? getValue(local.current) : undefined}
      defaultValue={local.defaultValue ? getValue(local.defaultValue) : undefined}
      onChange={(v) => local.onSelect?.(findOption(v))}
    >
      <div role="presentation" data-slot="radio-group-wrapper" class="ui-radio-group-wrapper">
        <Kobalte.Indicator data-slot="radio-group-indicator" class="ui-radio-group-indicator" />
        <div role="presentation" data-slot="radio-group-items" class="ui-radio-group-items">
          <For each={local.options}>
            {(option) => (
              <Kobalte.Item value={getValue(option)} data-slot="radio-group-item" class="ui-radio-group-item" data-value={getValue(option)}>
                <Kobalte.ItemInput data-slot="radio-group-item-input" />
                <Kobalte.ItemLabel data-slot="radio-group-item-label" class="ui-radio-group-item-label">
                  <span data-slot="radio-group-item-control" class="ui-radio-group-item-control">{getLabel(option)}</span>
                </Kobalte.ItemLabel>
              </Kobalte.Item>
            )}
          </For>
        </div>
      </div>
    </Kobalte>
  )
}

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
  /** Trailing controls; they sit outside the label, so pressing one does not select the row. */
  children?: JSX.Element
}

export function RadioListItem(props: RadioListItemProps) {
  const [local, others] = splitProps(props, ["children", "class", "classList", "label"])
  return (
    <KobalteRadio.Item
      {...others}
      data-slot="radio-list-item"
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
      <KobalteRadio.ItemLabel data-slot="radio-list-item-label" class="ui-radio-list-item-label">
        {local.label}
      </KobalteRadio.ItemLabel>
      {local.children}
    </KobalteRadio.Item>
  )
}
