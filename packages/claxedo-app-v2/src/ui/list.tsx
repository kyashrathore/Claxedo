import { createEffect, For, on, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useFilteredList, type FilteredListProps } from "./filtered-list"
import { type IconName } from "./icon"
import { ListEmpty, ListGroupHeader, ListItem } from "./list-items"
import { findListItem, scrollListItemIntoView } from "./list-scroll"
import { ListSearch, type ListSearchProps } from "./list-search"
import "./list.css"

export type { ListSearchProps }

export interface ListAddProps {
  class?: string
  render: () => JSX.Element
}

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
  groupHeader?: (group: { category: string; items: T[] }) => JSX.Element
  ref?: (ref: ListRef) => void
}

export interface ListRef {
  onKeyDown: (event: KeyboardEvent) => void
  setScrollRef: (element: HTMLDivElement | undefined) => void
  setFilter: (value: string) => void
}

export function List<T>(props: ListProps<T>) {
  let input: HTMLInputElement | undefined
  const [store, setStore] = createStore({ mouseActive: false, scroll: undefined as HTMLDivElement | undefined, filter: "" })
  const list = useFilteredList<T>(props)
  const search = () => (typeof props.search === "object" ? props.search : {})
  const showAdd = () => !!props.add

  const applyFilter = (value: string, refetch = false) => {
    const previous = list.filter()
    setStore("filter", value)
    list.onInput(value)
    props.onFilter?.(value)
    if (!refetch) return
    if (previous === value) return void list.refetch()
    queueMicrotask(() => list.refetch())
  }

  const reveal = (key: string | null, block: "center" | "nearest") => {
    const scroll = store.scroll
    if (!scroll || !key) return
    const element = findListItem(scroll, key)
    if (element) scrollListItemIntoView(scroll, element, block)
  }

  createEffect(() => {
    if (props.filter === undefined || props.filter === store.filter) return
    setStore("filter", props.filter)
    list.onInput(props.filter)
  })
  createEffect(on(list.filter, () => store.scroll?.scrollTo(0, 0), { defer: true }))
  createEffect(() => {
    if (!props.current) return
    const key = props.key(props.current)
    requestAnimationFrame(() => reveal(key, "center"))
  })
  createEffect(() => {
    const all = list.flat()
    if (store.mouseActive || all.length === 0) return
    if (list.active() === props.key(all[0])) return store.scroll?.scrollTo(0, 0)
    reveal(list.active(), "center")
  })
  createEffect(() => props.onMove?.(list.flat().find((item) => props.key(item) === list.active())))

  const handleKey = (event: KeyboardEvent) => {
    setStore("mouseActive", false)
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

  props.ref?.({
    onKeyDown: handleKey,
    setScrollRef: (element) => setStore("scroll", element),
    setFilter: (value) => applyFilter(value, true),
  })

  const renderAdd = () => (
    <div data-slot="list-item-add" classList={{ "ui-list-item-add": true, [props.add?.class ?? ""]: !!props.add?.class }}>
      {props.add?.render()}
    </div>
  )

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
          setStore("mouseActive", true)
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
            applyFilter(value)
            if (!value) queueMicrotask(() => input?.focus())
          }}
          onKeyDown={handleKey}
          inputRef={(element) => (input = element)}
        />
      </Show>
      <div ref={(element) => setStore("scroll", element)} data-slot="list-scroll" class="ui-list-scroll">
        <Show
          when={list.flat().length > 0 || showAdd()}
          fallback={
            <ListEmpty loading={list.grouped.loading} filter={list.filter()} emptyMessage={props.emptyMessage} loadingMessage={props.loadingMessage} />
          }
        >
          <For each={list.grouped.latest}>
            {(group, groupIndex) => {
              const lastGroup = () => groupIndex() === list.grouped.latest.length - 1
              return (
                <div data-slot="list-group">
                  <Show when={group.category}>
                    <ListGroupHeader scroll={() => store.scroll}>{props.groupHeader?.(group) ?? group.category}</ListGroupHeader>
                  </Show>
                  <div data-slot="list-items">
                    <For each={group.items}>
                      {(item, index) => renderItem(item, index(), index() === group.items.length - 1 && !(showAdd() && lastGroup()))}
                    </For>
                    <Show when={showAdd() && lastGroup()}>{renderAdd()}</Show>
                  </div>
                </div>
              )
            }}
          </For>
          <Show when={list.grouped.latest.length === 0 && showAdd()}>
            <div data-slot="list-group">
              <div data-slot="list-items">{renderAdd()}</div>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  )
}
