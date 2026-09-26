import { Show, type JSX } from "solid-js"
import { useI18n } from "../context/i18n"
import { Icon } from "./icon"
import { IconButton } from "./icon-button"
import { TextField } from "./text-field"

export interface ListSearchProps {
  placeholder?: string
  autofocus?: boolean
  hideIcon?: boolean
  class?: string
  action?: JSX.Element
}

export function ListSearch(props: {
  readonly search: ListSearchProps
  readonly value: string
  readonly onChange: (value: string) => void
  readonly onClear: () => void
  readonly onKeyDown: (event: KeyboardEvent) => void
  readonly inputRef: (element: HTMLInputElement | HTMLTextAreaElement) => void
}): JSX.Element {
  const i18n = useI18n()
  return (
    <div data-slot="list-search-wrapper" class="ui-list-search-wrapper">
      <div
        data-slot="list-search"
        classList={{ "ui-list-search": true, [props.search.class ?? ""]: !!props.search.class }}
        onPointerDown={(event) => {
          const container = event.currentTarget
          const node = container.querySelector("input, textarea")
          if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) node.focus()
          event.stopPropagation()
        }}
      >
        <div data-slot="list-search-container">
          <Show when={!props.search.hideIcon}>
            <Icon name="magnifying-glass" />
          </Show>
          <TextField
            autofocus={props.search.autofocus}
            variant="ghost"
            data-slot="list-search-input"
            type="text"
            ref={props.inputRef}
            value={props.value}
            onChange={props.onChange}
            onKeyDown={props.onKeyDown}
            placeholder={props.search.placeholder}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
          />
        </div>
        <Show when={props.value}>
          <IconButton icon="circle-x" variant="ghost" onClick={props.onClear} aria-label={i18n.t("ui.list.clearFilter")} />
        </Show>
        {props.search.action}
      </div>
    </div>
  )
}
