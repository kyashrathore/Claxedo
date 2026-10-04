import { createEffect, createSelector, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useI18n } from "../context/i18n"
import { type FilteredListProps, useFilteredList } from "../hooks"
import type { IconProps } from "./icon"
import { ListGroups } from "./list-groups"
import { createListScroll } from "./list-scroll"
import { ListSearch, type ListSearchProps } from "./list-search"

export type { ListSearchProps } from "./list-search"

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
  activeIcon?: IconProps["name"]
  filter?: string
  search?: ListSearchProps | boolean
  itemWrapper?: (item: T, node: JSX.Element) => JSX.Element
  divider?: boolean
  add?: ListAddProps
  groupHeader?: (group: { category: string; items: T[] }) => JSX.Element
}

export interface ListRef {
  onKeyDown: (event: KeyboardEvent) => void
  setScrollRef: (element: HTMLDivElement | undefined) => void
  setFilter: (value: string) => void
}

function EmptyMessage(props: { readonly loading: boolean; readonly loadingMessage?: string; readonly emptyMessage?: string; readonly filter: string }): JSX.Element {
  const i18n = useI18n()
  const suffix = () => i18n.t("ui.list.emptyWithFilter.suffix")
  return (
    <Show when={!props.loading && !props.emptyMessage && props.filter} fallback={props.loading ? (props.loadingMessage ?? i18n.t("ui.list.loading")) : (props.emptyMessage ?? i18n.t("ui.list.empty"))}>
      <span>{i18n.t("ui.list.emptyWithFilter.prefix")}</span>
      <span data-slot="list-filter">&quot;{props.filter}&quot;</span>
      <Show when={suffix()}>
        <span>{suffix()}</span>
      </Show>
    </Show>
  )
}

function createListKeys<T>(props: ListProps<T>, list: ReturnType<typeof useFilteredList<T>>, setMouseActive: (active: boolean) => void) {
  return (event: KeyboardEvent) => {
    setMouseActive(false)
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
    if (!props.search) return list.onKeyDown(event)
    const emacs = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && (event.key === "n" || event.key === "p")
    if (emacs || event.key === "ArrowDown" || event.key === "ArrowUp") list.onKeyDown(event)
  }
}

export function List<T>(props: ListProps<T> & { ref?: (ref: ListRef) => void }): JSX.Element {
  let inputRef: HTMLInputElement | HTMLTextAreaElement | undefined
  const [store, setStore] = createStore({ mouseActive: false, scrollRef: undefined as HTMLDivElement | undefined, internalFilter: "" })
  const list = useFilteredList<T>(props)
  const isActive = createSelector(list.active)
  const isCurrent = createSelector(() => props.current)
  const applyFilter = (value: string, options?: { ref?: boolean }) => {
    const previous = list.filter()
    setStore("internalFilter", value)
    list.onInput(value)
    props.onFilter?.(value)
    if (!options?.ref) return
    if (previous === value) void list.refetch()
    else queueMicrotask(() => list.refetch())
  }
  createEffect(() => {
    if (props.filter === undefined || props.filter === store.internalFilter) return
    setStore("internalFilter", props.filter)
    list.onInput(props.filter)
  })
  createListScroll({ scrollRef: () => store.scrollRef, filter: list.filter, flat: list.flat, active: list.active, key: props.key, current: () => props.current, mouseActive: () => store.mouseActive })
  createEffect(() => {
    const current = list.active()
    props.onMove?.(list.flat().find((item) => props.key(item) === current))
  })
  const onKeyDown = createListKeys(props, list, (active) => setStore("mouseActive", active))
  props.ref?.({ onKeyDown, setScrollRef: (element) => setStore("scrollRef", element), setFilter: (value) => applyFilter(value, { ref: true }) })
  const add = () => <div data-slot="list-item-add" classList={{ "ui-list-item-add": true, [props.add?.class ?? ""]: !!props.add?.class }}>{props.add?.render()}</div>
  return (
    <div classList={{ "ui-list": true, [props.class ?? ""]: !!props.class }}>
      <Show when={props.search}>
        <ListSearch
          search={typeof props.search === "object" ? props.search : {}}
          value={store.internalFilter}
          onChange={(value) => applyFilter(value)}
          onClear={() => {
            setStore("internalFilter", "")
            queueMicrotask(() => inputRef?.focus())
          }}
          onKeyDown={onKeyDown}
          inputRef={(element) => (inputRef = element)}
        />
      </Show>
      <div ref={(element) => setStore("scrollRef", element)} data-slot="list-scroll" class="ui-list-scroll">
        <Show
          when={list.flat().length > 0 || props.add}
          fallback={
            <div data-slot="list-empty-state">
              <div data-slot="list-message">
                <EmptyMessage loading={list.grouped.loading} loadingMessage={props.loadingMessage} emptyMessage={props.emptyMessage} filter={list.filter()} />
              </div>
            </div>
          }
        >
          <ListGroups
            groups={() => list.grouped.latest}
            scrollRef={() => store.scrollRef}
            key={props.key}
            isActive={isActive}
            isCurrent={(item) => isCurrent(item)}
            activeIcon={props.activeIcon}
            divider={props.divider}
            add={props.add ? add : undefined}
            groupHeader={props.groupHeader}
            itemWrapper={props.itemWrapper}
            onSelect={(item, index) => props.onSelect?.(item, index)}
            onKeyDown={onKeyDown}
            onPointerActive={(key) => {
              setStore("mouseActive", true)
              list.setActive(key)
            }}
            onPointerLeave={() => store.mouseActive && list.setActive(null)}
          >
            {props.children}
          </ListGroups>
          <Show when={list.grouped.latest.length === 0 && props.add}>
            <div data-slot="list-group">
              <div data-slot="list-items">{add()}</div>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  )
}
