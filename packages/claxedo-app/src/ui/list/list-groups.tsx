import { createEffect, createMemo, For, Show, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"

export type ListGroup<T> = { readonly category: string; readonly items: T[] }

export type ListGroupsProps<T> = {
  readonly groups: Accessor<readonly ListGroup<T>[]>
  readonly scrollRef: Accessor<HTMLDivElement | undefined>
  readonly key: (item: T) => string
  readonly isActive: (key: string) => boolean
  readonly isCurrent: (item: T | undefined) => boolean
  readonly activeIcon?: IconProps["name"]
  readonly divider?: boolean
  readonly add?: () => JSX.Element
  readonly groupHeader?: (group: ListGroup<T>) => JSX.Element
  readonly itemWrapper?: (item: T, node: JSX.Element) => JSX.Element
  readonly children: (item: T) => JSX.Element
  readonly onSelect: (item: T, index: number) => void
  readonly onKeyDown: (event: KeyboardEvent) => void
  readonly onPointerActive: (key: string) => void
  readonly onPointerLeave: () => void
}

function GroupHeader<T>(props: { readonly group: ListGroup<T>; readonly scrollRef: Accessor<HTMLDivElement | undefined>; readonly render?: (group: ListGroup<T>) => JSX.Element }): JSX.Element {
  const [state, setState] = createStore({ stuck: false, header: undefined as HTMLDivElement | undefined })
  createEffect(() => {
    const scroll = props.scrollRef()
    const node = state.header
    if (!scroll || !node) return
    const handler = () => {
      const rect = node.getBoundingClientRect()
      const scrollRect = scroll.getBoundingClientRect()
      setState("stuck", rect.top <= scrollRect.top + 1 && scroll.scrollTop > 0)
    }
    makeEventListener(scroll, "scroll", handler, { passive: true })
    handler()
  })
  return (
    <div data-slot="list-header" class="ui-list-header" data-stuck={state.stuck} ref={(element) => setState("header", element)}>
      {props.render?.(props.group) ?? props.group.category}
    </div>
  )
}

function ListRow<T>(props: { readonly list: ListGroupsProps<T>; readonly item: T; readonly index: Accessor<number>; readonly last: Accessor<boolean> }): JSX.Element {
  const key = () => props.list.key(props.item)
  const moved = (event: MouseEvent) => event.movementX !== 0 || event.movementY !== 0
  const node = (
    <button
      data-slot="list-item"
      class="ui-list-item"
      data-key={key()}
      data-active={props.list.isActive(key())}
      data-selected={props.list.isCurrent(props.item)}
      onClick={() => props.list.onSelect(props.item, props.index())}
      onKeyDown={props.list.onKeyDown}
      type="button"
      onMouseMove={(event) => {
        if (moved(event)) props.list.onPointerActive(key())
      }}
      onMouseLeave={() => props.list.onPointerLeave()}
    >
      {props.list.children(props.item)}
      <Show when={props.list.isCurrent(props.item)}>
        <span data-slot="list-item-selected-icon" class="ui-list-item-selected-icon">
          <Icon name="check-small" />
        </span>
      </Show>
      <Show when={props.list.activeIcon}>
        {(icon) => (
          <span data-slot="list-item-active-icon" class="ui-list-item-active-icon">
            <Icon name={icon()} />
          </span>
        )}
      </Show>
      {props.list.divider && !props.last() && <span data-slot="list-item-divider" class="ui-list-item-divider" />}
    </button>
  )
  return props.list.itemWrapper ? props.list.itemWrapper(props.item, node) : node
}

export function ListGroups<T>(props: ListGroupsProps<T>): JSX.Element {
  const categories = createMemo(() => props.groups().map((group) => group.category), [], {
    equals: (a, b) => a.length === b.length && a.every((category, index) => category === b[index]),
  })
  const itemsOf = (category: string) => props.groups().find((group) => group.category === category)?.items ?? []
  return (
    <For each={categories()}>
      {(category, groupIndex) => {
        const items = createMemo(() => itemsOf(category))
        const isLastGroup = () => groupIndex() === categories().length - 1
        return (
          <div data-slot="list-group">
            <Show when={category}>
              <GroupHeader group={{ category, items: items() }} scrollRef={props.scrollRef} render={props.groupHeader} />
            </Show>
            <div data-slot="list-items">
              <For each={items()}>
                {(item, index) => (
                  <ListRow list={props} item={item} index={index} last={() => index() === items().length - 1 && !(props.add && isLastGroup())} />
                )}
              </For>
              <Show when={props.add && isLastGroup()}>{props.add?.()}</Show>
            </div>
          </div>
        )
      }}
    </For>
  )
}
