import { createVirtualizer } from "@tanstack/solid-virtual"
import { For, Show } from "solid-js"
import { useModelVisibility } from "@/composer"
import { SettingsRow } from "@/settings"
import { Switch } from "@/ui"
import { modelKeyOf, groupContext, type ModelItem, type SourceGroup } from "../model-sources"

type ModelRowsProps = { readonly entry: SourceGroup; readonly items: readonly ModelItem[] }

function ModelRow(props: { readonly entry: SourceGroup; readonly item: ModelItem }) {
  const visibility = useModelVisibility()
  return (
    <SettingsRow title={props.item.name}>
      <Switch
        class="pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:justify-center"
        checked={visibility.visible(modelKeyOf(props.item), groupContext(props.entry, props.item))}
        onChange={(checked) => visibility.setVisibility(modelKeyOf(props.item), checked)}
        hideLabel
      >
        {props.item.name}
      </Switch>
    </SettingsRow>
  )
}

function VirtualModelRows(props: ModelRowsProps) {
  let scroller: HTMLDivElement | undefined
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return props.items.length
    },
    getScrollElement: () => scroller ?? null,
    estimateSize: () => 44,
    getItemKey: (index) => props.items[index]!.id,
    overscan: 5,
  })
  return (
    <div ref={scroller} class="max-h-96 overflow-auto" role="list" aria-label={props.entry.providerName} tabIndex={0}>
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
        <For each={virtualizer.getVirtualItems()}>
          {(row) => (
            <div
              role="listitem"
              class="border-b border-border-weak-base"
              classList={{ "border-none": row.index === props.items.length - 1 }}
              ref={virtualizer.measureElement}
              data-index={row.index}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${row.start}px)` }}
            >
              <ModelRow entry={props.entry} item={props.items[row.index]!} />
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

export function ModelRows(props: ModelRowsProps) {
  return (
    <Show
      when={props.items.length > 100}
      fallback={<For each={props.items}>{(item) => <ModelRow entry={props.entry} item={item} />}</For>}
    >
      <VirtualModelRows {...props} />
    </Show>
  )
}
