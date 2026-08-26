import { storePath } from "solid-js"
import fuzzysort from "fuzzysort"
import { entries, flatMap, groupBy, map, pipe } from "remeda"
import { createEffect, createMemo, createSignal, refresh } from "solid-js"
import { createStore } from "solid-js"

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
  type GroupResult = { loading: boolean; groups: Group[] }

  const result = createMemo<GroupResult>(
    async () => {
      const filter = store.filter
      const items = typeof props.items === "function" ? props.items(filter) : props.items
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
          const filtered =
            !props.filterKeys && Array.isArray(filterable) && filterable.every((e) => typeof e === "string")
              ? (fuzzysort.go(needle, filterable).map((x) => x.target) as T[])
              : fuzzysort.go(needle, filterable, { keys: props.filterKeys! }).map((x) => x.obj)
          return skipped.length ? [...filtered, ...skipped] : filtered
        },
        groupBy((x) => (props.groupBy ? props.groupBy(x) : "")),
        entries(),
        map(([k, v]) => ({ category: k, items: props.sortBy ? v.sort(props.sortBy) : v })),
        (groups) => (props.sortGroupsBy ? groups.sort(props.sortGroupsBy) : groups),
      )
      return { loading: false, groups: result }
    },
    { loadingValue: { loading: true, groups: empty } },
  )
  const grouped = () => result().groups
  const loading = () => result().loading

  const flat = createMemo(() => {
    return pipe(
      grouped(),
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

  const [active, setActive] = createSignal<string | null>(initialActive())

  const onListKeyDown = (event: KeyboardEvent) => {
    const items = flat().map(props.key)
    if (items.length === 0) return
    const current = items.indexOf(active() ?? "")
    const select = (index: number) => setActive(items[(index + items.length) % items.length] ?? "")
    const key = event.key.toLowerCase()
    if (key === "arrowdown") {
      event.preventDefault()
      select(current < 0 ? 0 : current + 1)
      return
    }
    if (key === "arrowup") {
      event.preventDefault()
      select(current < 0 ? items.length - 1 : current - 1)
      return
    }
    if (key === "home") {
      event.preventDefault()
      select(0)
      return
    }
    if (key === "end") {
      event.preventDefault()
      select(items.length - 1)
      return
    }
    if (key === "tab" && current >= 0) {
      const next = event.shiftKey ? current - 1 : current + 1
      if (next >= 0 && next < items.length) {
        event.preventDefault()
        select(next)
      }
    }
  }

  const reset = () => {
    if (props.noInitialSelection) {
      setActive("")
      return
    }
    const all = flat()
    if (all.length === 0) return
    setActive(props.key(all[0]))
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault()
      const selectedIndex = flat().findIndex((x) => props.key(x) === active())
      const selected = flat()[selectedIndex]
      if (selected) props.onSelect?.(selected, selectedIndex)
    } else if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      if (event.key === "n" || event.key === "p") {
        event.preventDefault()
        const navEvent = new KeyboardEvent("keydown", {
          key: event.key === "n" ? "ArrowDown" : "ArrowUp",
          bubbles: true,
        })
        onListKeyDown(navEvent)
      }
    } else {
      // Skip list navigation for text editing shortcuts (e.g., Option+Arrow, Option+Backspace on macOS)
      if (event.altKey || event.metaKey) return
      onListKeyDown(event)
    }
  }

  createEffect(grouped, () => {
    reset()
  })

  const onInput = (value: string) => {
    setStore(storePath("filter", value))
  }

  return {
    grouped,
    loading,
    filter: () => store.filter,
    flat,
    reset,
    refetch: () => refresh(result),
    clear: () => setStore(storePath("filter", "")),
    onKeyDown,
    onInput,
    active,
    setActive,
  }
}
