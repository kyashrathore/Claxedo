import { For, Index, Show } from "solid-js"
import { useTranslator } from "@/i18n"
import { Spinner } from "@/ui"
import type { ComboChoice } from "../combobox-options"
import { surfaceDictionary } from "../i18n"
import { SurfaceIcon } from "./surface-icon"

export type ComboboxListProps = {
  readonly id: string
  readonly choices: readonly ComboChoice[]
  readonly chosen: readonly string[]
  readonly multiple: boolean
  readonly active: number
  readonly searching: boolean
  readonly emptyText: string | undefined
  readonly optionId: (index: number) => string
  readonly onChoose: (choice: ComboChoice) => void
}

export function ComboboxList(props: ComboboxListProps) {
  const t = useTranslator(surfaceDictionary)
  return (
    <div data-slot="surface-combobox-popup">
      <Show when={props.searching}>
        <span data-slot="surface-combobox-status" role="status">
          <Spinner />
          {t("surface.combobox.searching")}
        </span>
      </Show>
      <ul id={props.id} role="listbox" data-slot="surface-combobox-list" aria-multiselectable={props.multiple ? "true" : undefined}>
        <Index each={props.choices}>
          {(choice, index) => (
            <li
              id={props.optionId(index)}
              role="option"
              data-slot="surface-combobox-option"
              data-active={props.active === index ? "true" : "false"}
              aria-selected={props.chosen.includes(choice().value)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => props.onChoose(choice())}
            >
              <span data-slot="surface-combobox-option-label">{choice().label}</span>
              <Show when={choice().description}>{(description) => <span data-slot="surface-combobox-option-description">{description()}</span>}</Show>
            </li>
          )}
        </Index>
      </ul>
      <Show when={!props.searching && props.choices.length === 0}>
        <span data-slot="surface-combobox-empty">{props.emptyText ?? t("surface.combobox.empty")}</span>
      </Show>
    </div>
  )
}

export function ComboboxChips(props: { readonly chosen: readonly ComboChoice[]; readonly onRemove: (choice: ComboChoice) => void }) {
  const t = useTranslator(surfaceDictionary)
  return (
    <Show when={props.chosen.length > 0}>
      <div data-slot="surface-combobox-chips">
        <For each={props.chosen}>
          {(choice) => (
            <span data-slot="surface-combobox-chip">
              {choice.label}
              <button type="button" data-slot="surface-combobox-chip-remove" aria-label={t("surface.combobox.remove", { label: choice.label })} onClick={() => props.onRemove(choice)}>
                <SurfaceIcon name="close" size="small" />
              </button>
            </span>
          )}
        </For>
      </div>
    </Show>
  )
}
