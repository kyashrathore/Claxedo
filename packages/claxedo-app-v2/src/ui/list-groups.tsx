import { For, Show, type JSX } from "solid-js"
import type { FilteredGroup } from "./filtered-list"
import { ListGroupHeader } from "./list-items"

export interface ListAddProps {
  class?: string
  render: () => JSX.Element
}

export function ListGroups<T>(props: {
  groups: FilteredGroup<T>[]
  scroll: () => HTMLDivElement | undefined
  add?: ListAddProps
  groupHeader?: (group: FilteredGroup<T>) => JSX.Element
  renderItem: (item: T, index: number, last: boolean) => JSX.Element
}) {
  const showAdd = () => !!props.add
  const renderAdd = () => (
    <div data-slot="v2-list-item-add" classList={{ "v2-list-item-add": true, [props.add?.class ?? ""]: !!props.add?.class }}>
      {props.add?.render()}
    </div>
  )

  return (
    <>
      <For each={props.groups}>
        {(group, groupIndex) => {
          const lastGroup = () => groupIndex() === props.groups.length - 1
          return (
            <div data-slot="v2-list-group">
              <Show when={group.category}>
                <ListGroupHeader scroll={props.scroll}>{props.groupHeader?.(group) ?? group.category}</ListGroupHeader>
              </Show>
              <div data-slot="v2-list-items">
                <For each={group.items}>
                  {(item, index) => props.renderItem(item, index(), index() === group.items.length - 1 && !(showAdd() && lastGroup()))}
                </For>
                <Show when={showAdd() && lastGroup()}>{renderAdd()}</Show>
              </div>
            </div>
          )
        }}
      </For>
      <Show when={props.groups.length === 0 && showAdd()}>
        <div data-slot="v2-list-group">
          <div data-slot="v2-list-items">{renderAdd()}</div>
        </div>
      </Show>
    </>
  )
}
