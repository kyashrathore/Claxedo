import { Show, type JSX } from "solid-js"
import { Icon } from "./icon"
import { TextInput } from "./text-input"

export interface ListSearchProps {
  placeholder?: string
  autofocus?: boolean
  hideIcon?: boolean
  clearLabel?: string
  class?: string
  action?: JSX.Element
}

export function ListSearch(props: {
  search: ListSearchProps
  value: string
  onInput: (value: string) => void
  onKeyDown: (event: KeyboardEvent) => void
  inputRef: (element: HTMLInputElement) => void
}) {
  return (
    <div data-slot="list-search-wrapper" class="ui-list-search-wrapper">
      <div
        data-slot="list-search"
        classList={{ "ui-list-search": true, [props.search.class ?? ""]: !!props.search.class }}
        onPointerDown={(event) => {
          const input = event.currentTarget.querySelector("input")
          input?.focus()
          event.stopPropagation()
        }}
      >
        <TextInput
          ref={props.inputRef}
          autofocus={props.search.autofocus}
          data-slot="list-search-input"
          leadingIcon={props.search.hideIcon ? undefined : <Icon name="magnifying-glass" />}
          value={props.value}
          onInput={(event) => props.onInput(event.currentTarget.value)}
          onKeyDown={props.onKeyDown}
          placeholder={props.search.placeholder}
          showClearButton={props.value.length > 0}
          clearLabel={props.search.clearLabel ?? "Clear search"}
          onClearClick={() => props.onInput("")}
          spellcheck={false}
          autocorrect="off"
          autocomplete="off"
          autocapitalize="off"
        />
        <Show when={props.search.action}>{(action) => <div data-slot="list-search-action">{action()}</div>}</Show>
      </div>
    </div>
  )
}
