import { createEffect, on } from "solid-js"
import { createStore } from "solid-js/store"
import { useFilteredList, type FilteredListProps } from "./filtered-list"
import { findListItem, scrollListItemIntoView } from "./list-scroll"

export interface ListStateProps<T> extends FilteredListProps<T> {
  filter?: string
  onFilter?: (value: string) => void
  onMove?: (item: T | undefined) => void
}

type FilteredList<T> = ReturnType<typeof useFilteredList<T>>

interface ListStore {
  mouseActive: boolean
  scroll: HTMLDivElement | undefined
  filter: string
}

export function createListState<T>(props: ListStateProps<T>) {
  const [store, setStore] = createStore<ListStore>({ mouseActive: false, scroll: undefined, filter: "" })
  const list = useFilteredList<T>(props)

  const setFilter = (value: string) => {
    setStore("filter", value)
    list.onInput(value)
  }

  const applyFilter = (value: string, refetch = false) => {
    const previous = list.filter()
    setFilter(value)
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

  followListSelection({ props, list, store, setFilter, reveal })

  return {
    list,
    store,
    applyFilter,
    setScroll: (element: HTMLDivElement | undefined) => setStore("scroll", element),
    setMouseActive: (value: boolean) => setStore("mouseActive", value),
  }
}

function followListSelection<T>(state: {
  props: ListStateProps<T>
  list: FilteredList<T>
  store: ListStore
  setFilter: (value: string) => void
  reveal: (key: string | null, block: "center" | "nearest") => void
}) {
  const { props, list, store } = state
  createEffect(() => {
    if (props.filter === undefined || props.filter === store.filter) return
    state.setFilter(props.filter)
  })
  createEffect(on(list.filter, () => store.scroll?.scrollTo(0, 0), { defer: true }))
  createEffect(() => {
    if (!props.current) return
    const key = props.key(props.current)
    requestAnimationFrame(() => state.reveal(key, "center"))
  })
  createEffect(() => {
    const all = list.flat()
    if (store.mouseActive || all.length === 0) return
    if (list.active() === props.key(all[0])) return store.scroll?.scrollTo(0, 0)
    state.reveal(list.active(), "center")
  })
  createEffect(() => props.onMove?.(list.flat().find((item) => props.key(item) === list.active())))
}
