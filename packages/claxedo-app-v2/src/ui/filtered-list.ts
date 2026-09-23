import fuzzysort from "fuzzysort"
import { entries, flatMap, groupBy, map, pipe } from "remeda"
import { createEffect, createMemo, createResource, createSignal, on } from "solid-js"
import { createStore } from "solid-js/store"

export interface FilteredListProps<T> {
  items: T[] | ((filter: string) => T[] | Promise<T[]>)
  key: (item: T) => string
  filterKeys?: string[]
  current?: T
  groupBy?: (item: T) => string
  sortBy?: (a: T, b: T) => number
  sortGroupsBy?: (a: FilteredGroup<T>, b: FilteredGroup<T>) => number
  skipFilter?: (item: T) => boolean
  onSelect?: (value: T | undefined, index: number) => void
  noInitialSelection?: boolean
}

export type FilteredGroup<T> = { category: string; items: T[] }

function createActiveItem(items: () => string[], initial: string | null) {
  const [active, setActive] = createSignal<string | null>(initial)
  const jump = (index: number) => {
    const all = items()
    if (all.length > 0) setActive(all[(index + all.length) % all.length])
  }
  const onKeyDown = (event: KeyboardEvent) => {
    const all = items()
    const index = all.indexOf(active() ?? "")
    if (event.key === "ArrowDown") jump(index + 1)
    else if (event.key === "ArrowUp") jump(index === -1 ? all.length - 1 : index - 1)
    else if (event.key === "Home") jump(0)
    else if (event.key === "End") jump(all.length - 1)
    else return
    event.preventDefault()
  }
  return { active, setActive, onKeyDown }
}

function search<T>(items: T[], needle: string, props: FilteredListProps<T>) {
  if (!needle) return items
  const skipped = props.skipFilter ? items.filter(props.skipFilter) : []
  const filterable = props.skipFilter ? items.filter((item) => !props.skipFilter?.(item)) : items
  const keys = props.filterKeys
  const found = keys
    ? fuzzysort.go(needle, filterable, { keys }).map((result) => result.obj)
    : fuzzysort.go(needle, filterable, { key: (item) => (typeof item === "string" ? item : "") }).map((result) => result.obj)
  return skipped.length ? [...found, ...skipped] : found
}

export function useFilteredList<T>(props: FilteredListProps<T>) {
  const [store, setStore] = createStore({ filter: "" })
  const empty: FilteredGroup<T>[] = []

  const [grouped, { refetch }] = createResource(
    () => ({
      filter: store.filter,
      items: typeof props.items === "function" ? props.items(store.filter) : props.items,
    }),
    async ({ filter, items }) => {
      const all = (await Promise.resolve(items)) || []
      return pipe(
        search(all, filter.toLowerCase(), props),
        groupBy((item) => (props.groupBy ? props.groupBy(item) : "")),
        entries(),
        map(([category, items]): FilteredGroup<T> => ({ category, items: props.sortBy ? items.sort(props.sortBy) : items })),
        (groups) => (props.sortGroupsBy ? groups.sort(props.sortGroupsBy) : groups),
      )
    },
    { initialValue: empty },
  )

  const flat = createMemo(() =>
    pipe(
      grouped.latest || [],
      flatMap((group) => group.items),
    ),
  )

  const firstKey = () => {
    if (props.noInitialSelection) return null
    if (props.current) return props.key(props.current)
    const items = flat()
    return items.length > 0 ? props.key(items[0]) : null
  }

  const list = createActiveItem(() => flat().map(props.key), firstKey())

  const reset = () => list.setActive(firstKey())

  const select = (event: KeyboardEvent) => {
    event.preventDefault()
    const items = flat()
    const index = items.findIndex((item) => props.key(item) === list.active())
    const selected = items[index] ?? (props.noInitialSelection ? undefined : items[0])
    if (selected) props.onSelect?.(selected, index === -1 ? 0 : index)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.isComposing) return select(event)
    if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && (event.key === "n" || event.key === "p")) {
      event.preventDefault()
      list.onKeyDown(new KeyboardEvent("keydown", { key: event.key === "n" ? "ArrowDown" : "ArrowUp", bubbles: true }))
      return
    }
    if (event.altKey || event.metaKey) return
    list.onKeyDown(event)
  }

  createEffect(on(grouped, reset))

  return {
    grouped,
    filter: () => store.filter,
    flat,
    reset,
    refetch,
    clear: () => setStore("filter", ""),
    onKeyDown,
    onInput: (value: string) => setStore("filter", value),
    active: list.active,
    setActive: list.setActive,
  }
}
