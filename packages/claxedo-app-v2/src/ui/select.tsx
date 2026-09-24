import { Select as Kobalte } from "@kobalte/core/select"
import { createMemo, splitProps, type ComponentProps, type JSX } from "solid-js"
import { SelectChevron } from "./select-glyphs"
import { createSelectHighlight, type SelectHighlight } from "./select-highlight"
import { SelectItem, SelectSection } from "./select-items"
import { groupSelectOptions, selectItemText, type SelectGroup } from "./select-options"
import "./menu.css"
import "./select.css"

export type SelectProps<T> = Omit<
  ComponentProps<typeof Kobalte<T, SelectGroup<T>>>,
  "value" | "onSelect" | "children" | "options" | "itemComponent" | "sectionComponent" | "defaultValue" | "multiple"
> & {
  placeholder?: string
  options: T[]
  current?: T
  value?: (item: T) => string
  label?: (item: T) => string
  groupBy?: (item: T) => string
  onSelect?: (value: T | null) => void
  onHighlight?: SelectHighlight<T>
  appearance?: "base" | "large" | "inline"
  invalid?: boolean
  numeric?: boolean
  children?: (item: T) => JSX.Element
  valueClass?: string
}

export function Select<T>(props: SelectProps<T>) {
  const [local, others] = splitProps(props, [
    "class",
    "classList",
    "placeholder",
    "options",
    "current",
    "value",
    "label",
    "groupBy",
    "onSelect",
    "onHighlight",
    "onOpenChange",
    "children",
    "appearance",
    "invalid",
    "numeric",
    "disabled",
    "valueClass",
    "placement",
    "gutter",
    "sameWidth",
    "flip",
    "slide",
    "fitViewport",
  ])
  const inline = () => (local.appearance ?? "base") === "inline"
  const keyFor = (item: T) => (local.value ? local.value(item) : selectItemText(item))
  const labelFor = (item: T) => (local.label ? local.label(item) : selectItemText(item))
  const itemLabel = (item: T) => (local.children ? local.children(item) : labelFor(item))
  const highlight = createSelectHighlight(keyFor, () => local.onHighlight)
  const grouped = createMemo(() => groupSelectOptions(local.options, local.groupBy))

  return (
    <Kobalte<T, SelectGroup<T>>
      {...others}
      multiple={false}
      disabled={local.disabled}
      data-component="v2-select-root"
      classList={{ "v2-select-root": true }}
      placement={local.placement ?? (inline() ? "bottom-end" : "bottom-start")}
      gutter={local.gutter ?? 4}
      sameWidth={local.sameWidth ?? !inline()}
      flip={local.flip ?? true}
      slide={local.slide ?? true}
      fitViewport={local.fitViewport ?? false}
      value={local.current}
      options={grouped()}
      optionValue={keyFor}
      optionTextValue={labelFor}
      optionGroupChildren="options"
      placeholder={local.placeholder}
      sectionComponent={(sectionProps) => <SelectSection section={sectionProps.section} />}
      itemComponent={(itemProps) => <SelectItem item={itemProps.item} label={itemLabel} onMove={highlight.move} />}
      onChange={(next) => {
        local.onSelect?.(next ?? null)
        highlight.stop()
      }}
      onOpenChange={(open) => {
        local.onOpenChange?.(open)
        if (!open) highlight.stop()
      }}
    >
      <Kobalte.Trigger
        as="div"
        data-component="v2-select"
        data-appearance={local.appearance ?? "base"}
        data-invalid={local.invalid ? "" : undefined}
        data-numeric={local.numeric ? "" : undefined}
        disabled={local.disabled}
        data-disabled={local.disabled ? "" : undefined}
        classList={{ "v2-select": true, ...local.classList, [local.class ?? ""]: !!local.class }}
      >
        <div data-slot="v2-select-value">
          <Kobalte.Value<T> data-slot="v2-select-value-text" class={local.valueClass} classList={{ "v2-select-value-text": true }}>
            {(state) => {
              const selected = state.selectedOption()
              return selected == null ? "" : labelFor(selected)
            }}
          </Kobalte.Value>
        </div>
        <span data-slot="v2-select-chevron" class="v2-select-chevron" aria-hidden="true">
          <SelectChevron />
        </span>
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content data-component="v2-menu-content" data-slot="v2-select-content">
          <Kobalte.Listbox data-slot="v2-select-listbox" />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
