import { Show } from "solid-js"
import { Icon } from "@/ui"
import { boundBoolean } from "../binding"
import { surfaceIcon } from "../icon-names"
import type { SurfaceNodeProps } from "../model"
import { SurfaceGroup } from "./surface-children"
import { useSurfaceReader } from "./surface-runtime"

export function ListItemView(props: SurfaceNodeProps<"ListItem">) {
  const read = useSurfaceReader()
  const selected = () => boundBoolean(read.value(props.def.selected, props.scope))
  return (
    <div data-slot="surface-list-item" aria-current={selected() ? "true" : undefined}>
      <Show when={surfaceIcon(read.value(props.def.icon, props.scope))}>
        {(name) => (
          <span data-slot="surface-list-item-icon">
            <Icon name={name()} size="small" />
          </span>
        )}
      </Show>
      <div data-slot="surface-list-item-body">
        <div data-slot="surface-list-item-text">
          <span data-slot="surface-list-item-title">{read.text(props.def.title, props.scope)}</span>
          <Show when={read.text(props.def.subtitle, props.scope)}>{(text) => <span data-slot="surface-list-item-subtitle">{text()}</span>}</Show>
        </div>
        <SurfaceGroup ids={props.def.meta} scope={props.scope} slot="surface-meta" />
        <SurfaceGroup ids={props.def.actions} scope={props.scope} slot="surface-actions" />
      </div>
    </div>
  )
}
