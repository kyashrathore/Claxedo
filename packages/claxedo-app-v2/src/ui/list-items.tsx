import { makeEventListener } from "@solid-primitives/event-listener"
import { createEffect, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon, type IconName } from "./icon"

export function ListGroupHeader(props: { scroll: () => HTMLDivElement | undefined; children: JSX.Element }) {
  const [state, setState] = createStore({ stuck: false, header: undefined as HTMLDivElement | undefined })

  createEffect(() => {
    const scroll = props.scroll()
    const node = state.header
    if (!scroll || !node) return
    const measure = () => {
      const rect = node.getBoundingClientRect()
      const scrollRect = scroll.getBoundingClientRect()
      setState("stuck", rect.top <= scrollRect.top + 1 && scroll.scrollTop > 0)
    }
    makeEventListener(scroll, "scroll", measure, { passive: true })
    measure()
  })

  return (
    <div data-slot="list-header" class="ui-list-header" data-stuck={state.stuck} ref={(element) => setState("header", element)}>
      {props.children}
    </div>
  )
}

export function ListItem(props: {
  itemKey: string
  active: boolean
  selected: boolean
  divider: boolean
  activeIcon?: IconName
  onSelect: () => void
  onKeyDown: (event: KeyboardEvent) => void
  onHover: () => void
  onLeave: () => void
  children: JSX.Element
}) {
  return (
    <button
      type="button"
      data-slot="list-item"
      class="ui-list-item"
      data-key={props.itemKey}
      data-active={props.active}
      data-selected={props.selected}
      onClick={() => props.onSelect()}
      onKeyDown={(event) => props.onKeyDown(event)}
      onMouseMove={(event) => {
        if (event.movementX !== 0 || event.movementY !== 0) props.onHover()
      }}
      onMouseLeave={() => props.onLeave()}
    >
      {props.children}
      <Show when={props.selected}>
        <span data-slot="list-item-selected-icon" class="ui-list-item-selected-icon">
          <Icon name="check-small" />
        </span>
      </Show>
      <Show when={props.activeIcon}>
        {(icon) => (
          <span data-slot="list-item-active-icon" class="ui-list-item-active-icon">
            <Icon name={icon()} />
          </span>
        )}
      </Show>
      <Show when={props.divider}>
        <span data-slot="list-item-divider" class="ui-list-item-divider" />
      </Show>
    </button>
  )
}

export function ListEmpty(props: { loading: boolean; filter: string; emptyMessage?: string; loadingMessage?: string }) {
  const message = () => {
    if (props.loading) return props.loadingMessage ?? "Loading…"
    if (props.emptyMessage) return props.emptyMessage
    if (!props.filter) return "Nothing here yet"
    return (
      <>
        <span>No results for </span>
        <span data-slot="list-filter">"{props.filter}"</span>
      </>
    )
  }
  return (
    <div data-slot="list-empty-state">
      <div data-slot="list-message">{message()}</div>
    </div>
  )
}
