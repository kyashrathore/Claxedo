import { Show } from "solid-js"
import { boundBoolean } from "../binding"
import { surfaceIconName } from "../icon-names"
import type { DataPath, SurfaceNodeProps } from "../model"
import { RowActionRoleProvider, useRepeated } from "./row-actions"
import { SurfaceGroup } from "./surface-children"
import { SurfaceIcon } from "./surface-icon"
import { useSurfaceReader } from "./surface-runtime"

function ListItemActions(props: { readonly primary: string | undefined; readonly secondary: string[] | undefined; readonly scope: DataPath; readonly repeated: boolean }) {
  const hasActions = () => props.primary !== undefined || (props.secondary?.length ?? 0) > 0
  return (
    <Show when={hasActions()}>
      <div data-slot="surface-actions">
        <RowActionRoleProvider value={props.repeated ? "row-secondary" : undefined}>
          <SurfaceGroup ids={props.secondary} scope={props.scope} slot="surface-row-secondary" />
        </RowActionRoleProvider>
        <RowActionRoleProvider value={props.repeated ? "row-primary" : undefined}>
          <SurfaceGroup ids={props.primary === undefined ? undefined : [props.primary]} scope={props.scope} slot="surface-row-primary" />
        </RowActionRoleProvider>
      </div>
    </Show>
  )
}

export function ListItemView(props: SurfaceNodeProps<"ListItem">) {
  const read = useSurfaceReader()
  const repeated = useRepeated()
  const selected = () => boundBoolean(read.value(props.def.selected, props.scope))
  const title = () => read.text(props.def.title, props.scope)
  const subtitle = () => read.text(props.def.subtitle, props.scope)
  return (
    <div data-slot="surface-list-item" data-repeated={repeated ? "true" : "false"} aria-current={selected() ? "true" : undefined}>
      <Show when={surfaceIconName(read.value(props.def.icon, props.scope))}>
        {(name) => (
          <span data-slot="surface-list-item-icon">
            <SurfaceIcon name={name()} size="small" />
          </span>
        )}
      </Show>
      <div data-slot="surface-list-item-body">
        <div data-slot="surface-list-item-text">
          <span data-slot="surface-list-item-title" title={title()}>
            {title()}
          </span>
          <Show when={subtitle()}>
            {(text) => (
              <span data-slot="surface-list-item-subtitle" title={text()}>
                {text()}
              </span>
            )}
          </Show>
          <SurfaceGroup ids={props.def.meta} scope={props.scope} slot="surface-meta" />
        </div>
        <ListItemActions primary={props.def.primaryAction} secondary={props.def.actions} scope={props.scope} repeated={repeated} />
      </div>
    </div>
  )
}
