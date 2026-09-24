import { Show, type JSX } from "solid-js"
import type { FilteredGroup, FilteredListProps } from "./filtered-list"
import type { IconName } from "./icon"
import { ListGroups, type ListAddProps } from "./list-groups"
import { ListEmpty, ListItem } from "./list-items"
import { ListSearch, type ListSearchProps } from "./list-search"
import { createListState } from "./list-state"
import "./list.css"

export type { ListAddProps, ListSearchProps }

export interface ListProps<T> extends FilteredListProps<T> {
  class?: string
  children: (item: T) => JSX.Element
  emptyMessage?: string
  loadingMessage?: string
  onKeyEvent?: (event: KeyboardEvent, item: T | undefined) => void
  onMove?: (item: T | undefined) => void
  onFilter?: (value: string) => void
  activeIcon?: IconName
  filter?: string
  search?: ListSearchProps | boolean
  itemWrapper?: (item: T, node: JSX.Element) => JSX.Element
  divider?: boolean
  add?: ListAddProps
  groupHeader?: (group: FilteredGroup<T>) => JSX.Element
  ref?: (ref: ListRef) => void
}

export interface ListRef {
  onKeyDown: (event: KeyboardEvent) => void
  setScrollRef: (element: HTMLDivElement | undefined) => void
  setFilter: (value: string) => void
}

export function List<T>(props: ListProps<T>) {
  let input: HTMLInputElement | undefined
  const state = createListState(props)
  const { list, store } = state
  const search = () => (typeof props.search === "object" ? props.search : {})

  const handleKey = (event: KeyboardEvent) => {
    state.setMouseActive(false)
    if (event.key === "Escape") return
    const all = list.flat()
    const selected = all.find((item) => props.key(item) === list.active())
    props.onKeyEvent?.(event, selected)
    if (event.defaultPrevented) return
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault()
      if (selected) props.onSelect?.(selected, all.indexOf(selected))
      return
    }
    const emacs = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && (event.key === "n" || event.key === "p")
    if (!props.search || emacs || event.key === "ArrowDown" || event.key === "ArrowUp") list.onKeyDown(event)
  }

  props.ref?.({ onKeyDown: handleKey, setScrollRef: state.setScroll, setFilter: (value) => state.applyFilter(value, true) })

  const renderItem = (item: T, index: number, last: boolean) => {
    const node = (
      <ListItem
        itemKey={props.key(item)}
        active={props.key(item) === list.active()}
        selected={item === props.current}
        divider={!!props.divider && !last}
        activeIcon={props.activeIcon}
        onSelect={() => props.onSelect?.(item, index)}
        onKeyDown={handleKey}
        onHover={() => {
          state.setMouseActive(true)
          list.setActive(props.key(item))
        }}
        onLeave={() => store.mouseActive && list.setActive(null)}
      >
        {props.children(item)}
      </ListItem>
    )
    return props.itemWrapper ? props.itemWrapper(item, node) : node
  }

  return (
    <div data-component="list" classList={{ "ui-list": true, [props.class ?? ""]: !!props.class }}>
      <Show when={!!props.search}>
        <ListSearch
          search={search()}
          value={store.filter}
          onInput={(value) => {
            state.applyFilter(value)
            if (!value) queueMicrotask(() => input?.focus())
          }}
          onKeyDown={handleKey}
          inputRef={(element) => (input = element)}
        />
      </Show>
      <div ref={state.setScroll} data-slot="list-scroll" class="ui-list-scroll">
        <Show
          when={list.flat().length > 0 || !!props.add}
          fallback={
            <ListEmpty loading={list.grouped.loading} filter={list.filter()} emptyMessage={props.emptyMessage} loadingMessage={props.loadingMessage} />
          }
        >
          <ListGroups groups={list.grouped.latest} scroll={() => store.scroll} add={props.add} groupHeader={props.groupHeader} renderItem={renderItem} />
        </Show>
      </div>
    </div>
  )
}
