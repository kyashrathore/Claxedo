import fuzzysort from "fuzzysort"
import { entries, flatMap, groupBy, map, pipe } from "remeda"
import { createEffect, createMemo, createResource, on } from "solid-js"
import { createStore } from "solid-js/store"
import { createList } from "solid-list"

export interface FilteredListProps<T> {
  items: T[] | ((filter: string) => T[] | Promise<T[]>)
  key: (item: T) => string
  filterKeys?: string[]
  current?: T
  groupBy?: (x: T) => string
  sortBy?: (a: T, b: T) => number
  sortGroupsBy?: (a: { category: string; items: T[] }, b: { category: string; items: T[] }) => number
  skipFilter?: (item: T) => boolean
  onSelect?: (value: T | undefined, index: number) => void
  noInitialSelection?: boolean
}

export function useFilteredList<T>(props: FilteredListProps<T>) {
  const [store, setStore] = createStore<{ filter: string }>({ filter: "" })

  type Group = { category: string; items: [T, ...T[]] }
  const empty: Group[] = []

  /** Search key for a list of plain strings, where each item is already its own text. */
  const itemText = (item: T) => (typeof item === "string" ? item : "")

  const [grouped, { refetch }] = createResource(
    () => ({
      filter: store.filter,
      items: typeof props.items === "function" ? props.items(store.filter) : props.items,
    }),
    async ({ filter, items }) => {
      const query = filter ?? ""
      const needle = query.toLowerCase()
      const all = (await Promise.resolve(items)) || []
      const result = pipe(
        all,
        (x) => {
          if (!needle) return x
          const skipFilter = props.skipFilter
          const filterable = skipFilter ? x.filter((item) => !skipFilter(item)) : x
          const skipped = skipFilter ? x.filter(skipFilter) : []
          // A list of plain strings is its own search text: search it through the same
          // key-based overload as everything else, so both branches yield the item itself.
          const filtered =
            !props.filterKeys && filterable.every((e) => typeof e === "string")
              ? fuzzysort.go(needle, filterable, { key: itemText }).map((x) => x.obj)
              : fuzzysort.go(needle, filterable, { keys: props.filterKeys! }).map((x) => x.obj)
          return skipped.length ? [...filtered, ...skipped] : filtered
        },
        groupBy((x) => (props.groupBy ? props.groupBy(x) : "")),
        entries(),
        map(([k, v]) => ({ category: k, items: props.sortBy ? v.sort(props.sortBy) : v })),
        (groups) => (props.sortGroupsBy ? groups.sort(props.sortGroupsBy) : groups),
      )
      return result
    },
    { initialValue: empty },
  )

  const flat = createMemo(() => {
    return pipe(
      grouped.latest || [],
      flatMap((x) => x.items),
    )
  })

  function initialActive() {
    if (props.noInitialSelection) return ""
    if (props.current) return props.key(props.current)

    const items = flat()
    if (items.length === 0) return ""
    return props.key(items[0])
  }

  const list = createList({
    items: () => flat().map(props.key),
    initialActive: initialActive(),
    loop: true,
  })

  const reset = () => {
    if (props.noInitialSelection) {
      list.setActive("")
      return
    }
    const all = flat()
    if (all.length === 0) return
    list.setActive(props.key(all[0]))
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault()
      const items = flat()
      const selectedIndex = items.findIndex((x) => props.key(x) === list.active())
      // `initialActive` is captured while `flat()` is still empty and `reset`
      // runs in an effect after the async filter resolves, so Enter can land
      // with items painted but no active key yet — same fallback they use.
      const fallback = props.noInitialSelection ? undefined : items[0]
      const selected = items[selectedIndex] ?? fallback
      if (selected) props.onSelect?.(selected, selectedIndex === -1 ? 0 : selectedIndex)
    } else if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      if (event.key === "n" || event.key === "p") {
        event.preventDefault()
        const navEvent = new KeyboardEvent("keydown", {
          key: event.key === "n" ? "ArrowDown" : "ArrowUp",
          bubbles: true,
        })
        list.onKeyDown(navEvent)
      }
    } else {
      // Skip list navigation for text editing shortcuts (e.g., Option+Arrow, Option+Backspace on macOS)
      if (event.altKey || event.metaKey) return
      list.onKeyDown(event)
    }
  }

  createEffect(
    on(grouped, () => {
      reset()
    }),
  )

  const onInput = (value: string) => {
    setStore("filter", value)
  }

  return {
    grouped,
    filter: () => store.filter,
    flat,
    reset,
    refetch,
    clear: () => setStore("filter", ""),
    onKeyDown,
    onInput,
    active: list.active,
    setActive: list.setActive,
  }
}
