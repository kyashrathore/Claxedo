import { storePath } from "solid-js"
import { type FilteredListProps, useFilteredList } from "@opencode-ai/ui/hooks"
import { createEffect, For, onSettled, Show, untrack } from "solid-js"
import { createKeySelector } from "../hooks/create-key-selector"
import type { JSX } from "@solidjs/web"
import { createStore } from "solid-js"
import { useI18n } from "../context/i18n"
import { Icon, type IconProps } from "./icon"
import { IconButton } from "./icon-button"
import { TextField } from "./text-field"
import { bindListeners } from "../hooks/bind-listeners"

function findByKey(container: HTMLElement, key: string) {
  const nodes = container.querySelectorAll<HTMLElement>('[data-slot="list-item"][data-key]')
  for (const node of nodes) {
    if (node.getAttribute("data-key") === key) return node
  }
}

export interface ListSearchProps {
  placeholder?: string
  autofocus?: boolean
  hideIcon?: boolean
  class?: string
  action?: JSX.Element
}

export interface ListAddProps {
  class?: string
  render: () => JSX.Element
}

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
  onKeyDown: (e: KeyboardEvent) => void
  setScrollRef: (el: HTMLDivElement | undefined) => void
  setFilter: (value: string) => void
}

export function List<T>(props: ListProps<T> & { ref?: (ref: ListRef) => void }) {
  const i18n = useI18n()
  let inputRef: HTMLInputElement | HTMLTextAreaElement | undefined
  const [store, setStore] = createStore({
    mouseActive: false,
    scrollRef: undefined as HTMLDivElement | undefined,
    internalFilter: "",
  })
  const scrollRef = () => store.scrollRef
  const setScrollRef = (el: HTMLDivElement | undefined) => setStore(storePath("scrollRef", el))
  const internalFilter = () => store.internalFilter
  const setInternalFilter = (value: string) => setStore(storePath("internalFilter", value))

  const scrollIntoView = (container: HTMLDivElement, node: HTMLElement, block: "center" | "nearest") => {
    const containerRect = container.getBoundingClientRect()
    const nodeRect = node.getBoundingClientRect()
    const top = nodeRect.top - containerRect.top + container.scrollTop
    const bottom = top + nodeRect.height
    const viewTop = container.scrollTop
    const viewBottom = viewTop + container.clientHeight
    const target =
      block === "center"
        ? top - container.clientHeight / 2 + nodeRect.height / 2
        : top < viewTop
          ? top
          : bottom > viewBottom
            ? bottom - container.clientHeight
            : viewTop
    const max = Math.max(0, container.scrollHeight - container.clientHeight)
    container.scrollTop = Math.max(0, Math.min(target, max))
  }

  const { filter, grouped, loading, flat, active, setActive, onKeyDown, onInput, refetch } = useFilteredList<T>(props)

  // O(1) keyed selection for the cursor. `active` changes on every arrow key
  // AND every mousemove across a row, and these lists are uncapped (the model
  // picker renders 100-300 rows). Binding rows to `props.key(item) === active()`
  // subscribes every row to the cursor, so one mousemove re-ran N comparisons;
  // rc.1's createProjection is worse still (it walks all subscribed key-signals
  // per store commit). createKeySelector flips exactly two per-key signals per
  // change — measured 14x faster than the memo shape and 56x faster than the
  // projection at N=2000 (contract-bench/framework-micro.ts).
  const cursorAt = createKeySelector(() => active() ?? undefined)

  const searchProps = () => (typeof props.search === "object" ? props.search : {})
  const searchAction = () => searchProps().action
  const addProps = () => props.add
  const showAdd = () => !!addProps()

  const moved = (event: MouseEvent) => event.movementX !== 0 || event.movementY !== 0

  const applyFilter = (value: string, options?: { ref?: boolean }) => {
    const prev = filter()
    setInternalFilter(value)
    onInput(value)
    props.onFilter?.(value)

    if (!options?.ref) return

    // Force a refetch even if the value is unchanged.
    // This is important for programmatic changes like Tab completion.
    if (prev === value) {
      void refetch()
      return
    }
    queueMicrotask(() => refetch())
  }

  // Two phases, like every effect below: the compute holds the reactive read
  // and the effect does the imperative work. `createTrackedEffect` tracks and
  // acts in one scope, which Solid 2 keeps for dynamic-subscription patterns
  // only — and a body that reads `props.*` there risks creating the compiler's
  // lazily-memoized prop getter inside a children-forbidden scope, which throws
  // uncaught and halts the reactive system.
  createEffect(
    () => props.filter,
    (next) => {
      if (next === undefined) return
      if (next === untrack(internalFilter)) return
      setInternalFilter(next)
      onInput(next)
    },
  )

  createEffect(
    filter,
    () => {
      scrollRef()?.scrollTo(0, 0)
    },
    { defer: true },
  )

  createEffect(
    () => {
      const scroll = scrollRef()
      const current = props.current
      return scroll && current ? { scroll, key: props.key(current) } : undefined
    },
    (target) => {
      if (!target) return
      requestAnimationFrame(() => {
        const element = findByKey(target.scroll, target.key)
        if (!element) return
        scrollIntoView(target.scroll, element, "center")
      })
    },
  )

  createEffect(
    () => {
      const all = flat()
      if (store.mouseActive || all.length === 0) return undefined
      const scroll = scrollRef()
      if (!scroll) return undefined
      return { scroll, first: props.key(all[0]), key: active() }
    },
    (target) => {
      if (!target) return
      if (target.key === target.first) {
        target.scroll.scrollTo(0, 0)
        return
      }
      if (!target.key) return
      const element = findByKey(target.scroll, target.key)
      if (!element) return
      scrollIntoView(target.scroll, element, "center")
    },
  )

  createEffect(
    () => {
      const all = flat()
      const current = active()
      return all.find((x) => props.key(x) === current)
    },
    (item) => props.onMove?.(item),
  )

  const handleSelect = (item: T | undefined, index: number) => {
    props.onSelect?.(item, index)
  }

  const handleKey = (e: KeyboardEvent) => {
    setStore(storePath("mouseActive", false))
    if (e.key === "Escape") return

    const all = flat()
    const selected = all.find((x) => props.key(x) === active())
    const index = selected ? all.indexOf(selected) : -1
    props.onKeyEvent?.(e, selected)

    if (e.defaultPrevented) return

    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault()
      if (selected) handleSelect(selected, index)
    } else if (props.search) {
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.key === "n" || e.key === "p")) {
        onKeyDown(e)
        return
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        onKeyDown(e)
      }
    } else {
      onKeyDown(e)
    }
  }

  onSettled(() => {
    props.ref?.({
      onKeyDown: handleKey,
      setScrollRef,
      setFilter: (value) => applyFilter(value, { ref: true }),
    })
  })

  const renderAdd = () => {
    const add = addProps()
    if (!add) return null
    return (
      <div data-slot="list-item-add" class={["ui-list-item-add", add.class]}>
        {add.render()}
      </div>
    )
  }

  function GroupHeader(groupProps: { group: { category: string; items: T[] } }): JSX.Element {
    const [state, setState] = createStore({
      stuck: false,
      header: undefined as HTMLDivElement | undefined,
    })

    createEffect(
      () => ({ scroll: scrollRef(), node: state.header }),
      ({ scroll, node }) => {
        if (!scroll || !node) return

        const handler = () => {
          const rect = node.getBoundingClientRect()
          const scrollRect = scroll.getBoundingClientRect()
          setState(storePath("stuck", rect.top <= scrollRect.top + 1 && scroll.scrollTop > 0))
        }

        // `bindListeners`, not `makeEventListener`: the latter registers an
        // `onCleanup`, which an effect phase does not accept either — this
        // scope takes its cleanup from what the callback returns.
        const unbind = bindListeners([scroll, "scroll", handler, { passive: true }])
        handler()
        return unbind
      },
    )

    return (
      <div
        data-slot="list-header"
        class="ui-list-header"
        data-stuck={state.stuck}
        ref={(el) => setState(storePath("header", el))}
      >
        {props.groupHeader?.(groupProps.group) ?? groupProps.group.category}
      </div>
    )
  }

  const emptyMessage = () => {
    if (loading()) return props.loadingMessage ?? i18n.t("ui.list.loading")
    if (props.emptyMessage) return props.emptyMessage

    const query = filter()
    if (!query) return i18n.t("ui.list.empty")

    const suffix = i18n.t("ui.list.emptyWithFilter.suffix")
    return (
      <>
        <span>{i18n.t("ui.list.emptyWithFilter.prefix")}</span>
        <span data-slot="list-filter">&quot;{query}&quot;</span>
        <Show when={suffix}>
          <span>{suffix}</span>
        </Show>
      </>
    )
  }

  return (
    <div data-component="list" class={["ui-list", props.class]}>
      <Show when={!!props.search}>
        <div data-slot="list-search-wrapper" class="ui-list-search-wrapper">
          <div
            data-slot="list-search"
            class={["ui-list-search", searchProps().class]}
            onPointerDown={(event) => {
              const container = event.currentTarget
              if (!(container instanceof HTMLElement)) return

              const node = container.querySelector("input, textarea")
              const input = node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? node : inputRef
              input?.focus()

              // Prevent global listeners (e.g. dnd sensors) from cancelling focus.
              event.stopPropagation()
            }}
          >
            <div data-slot="list-search-container">
              <Show when={!searchProps().hideIcon}>
                <Icon name="magnifying-glass" />
              </Show>
              <TextField
                autofocus={searchProps().autofocus}
                variant="ghost"
                data-slot="list-search-input"
                type="text"
                ref={(el: HTMLInputElement | HTMLTextAreaElement) => {
                  inputRef = el
                }}
                value={internalFilter()}
                onChange={(value) => applyFilter(value)}
                onKeyDown={handleKey}
                placeholder={searchProps().placeholder}
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
              />
            </div>
            <Show when={internalFilter()}>
              <IconButton
                icon="circle-x"
                variant="ghost"
                onClick={() => {
                  setInternalFilter("")
                  queueMicrotask(() => inputRef?.focus())
                }}
                aria-label={i18n.t("ui.list.clearFilter")}
              />
            </Show>
            {/* Inside the field, alongside the clear button — the two trailing
                controls belong to the input, so they share its fill the way the
                leading magnifier does. Outside it the action floated on the bare
                surface and read as unrelated to the search it acts on. */}
            {searchAction()}
          </div>
        </div>
      </Show>
      <div ref={setScrollRef} data-slot="list-scroll" class="ui-list-scroll">
        <Show
          when={flat().length > 0 || showAdd()}
          fallback={
            <div data-slot="list-empty-state">
              <div data-slot="list-message">{emptyMessage()}</div>
            </div>
          }
        >
          <For each={grouped()}>
            {(group, groupIndex) => {
              const isLastGroup = () => groupIndex() === grouped().length - 1
              return (
                <div data-slot="list-group">
                  <Show when={group.category}>
                    <GroupHeader group={group} />
                  </Show>
                  <div data-slot="list-items">
                    <For each={group.items}>
                      {(item, i) => {
                        const node = (
                          <button
                            data-slot="list-item"
                            class="ui-list-item"
                            data-key={props.key(item)}
                            data-active={cursorAt(props.key(item))}
                            data-selected={item === props.current}
                            onClick={() => handleSelect(item, i())}
                            onKeyDown={handleKey}
                            type="button"
                            onMouseMove={(event) => {
                              if (!moved(event)) return
                              setStore(storePath("mouseActive", true))
                              setActive(props.key(item))
                            }}
                            onMouseLeave={() => {
                              if (!store.mouseActive) return
                              setActive(null)
                            }}
                          >
                            {props.children(item)}
                            <Show when={item === props.current}>
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
                            {props.divider && (i() !== group.items.length - 1 || (showAdd() && isLastGroup())) && (
                              <span data-slot="list-item-divider" class="ui-list-item-divider" />
                            )}
                          </button>
                        )
                        if (props.itemWrapper) return props.itemWrapper(item, node)
                        return node
                      }}
                    </For>
                    <Show when={showAdd() && isLastGroup()}>{renderAdd()}</Show>
                  </div>
                </div>
              )
            }}
          </For>
          <Show when={grouped().length === 0 && showAdd()}>
            <div data-slot="list-group">
              <div data-slot="list-items">{renderAdd()}</div>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  )
}
