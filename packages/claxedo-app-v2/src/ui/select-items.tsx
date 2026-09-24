import { Select as Kobalte, type SelectRootItemComponentProps, type SelectRootSectionComponentProps } from "@kobalte/core/select"
import { Show, type JSX } from "solid-js"
import { SelectCheck } from "./select-glyphs"
import type { SelectGroup } from "./select-options"

export function SelectSection<T>(props: SelectRootSectionComponentProps<SelectGroup<T>>) {
  return (
    <Kobalte.Section>
      <Show when={props.section.rawValue.category}>
        <div data-slot="menu-group-label">{props.section.rawValue.category}</div>
      </Show>
    </Kobalte.Section>
  )
}

export function SelectItem<T>(
  props: SelectRootItemComponentProps<T> & { label: (item: T) => JSX.Element; onMove: (item: T) => void },
) {
  return (
    <Kobalte.Item
      item={props.item}
      data-component="menu-item"
      onPointerEnter={() => props.onMove(props.item.rawValue)}
      onPointerMove={() => props.onMove(props.item.rawValue)}
      onFocus={() => props.onMove(props.item.rawValue)}
    >
      <Kobalte.ItemLabel data-slot="menu-item-content" as="span">
        {props.label(props.item.rawValue)}
      </Kobalte.ItemLabel>
      <Kobalte.ItemIndicator data-slot="menu-item-indicator" forceMount>
        <SelectCheck />
      </Kobalte.ItemIndicator>
    </Kobalte.Item>
  )
}
