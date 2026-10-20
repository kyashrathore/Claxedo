import { Show } from "solid-js"
import { boundBoolean } from "../binding"
import { surfaceIconName } from "../icon-names"
import type { DataPath, SurfaceNodeProps } from "../model"
import { RowActionRoleProvider, useRepeated } from "./row-actions"
import { SurfaceGroup } from "./surface-children"
import { SurfaceIcon } from "./surface-icon"
import { SurfaceNode } from "./surface-node"
import { useSurfaceReader, useSurfaceRuntime } from "./surface-runtime"

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

function ListItemLead(props: { readonly def: SurfaceNodeProps<"ListItem">["def"]; readonly scope: DataPath }) {
  const read = useSurfaceReader()
  return (
    <Show
      when={props.def.leading}
      fallback={
        <Show when={surfaceIconName(read.value(props.def.icon, props.scope))}>
          {(name) => (
            <span data-slot="surface-list-item-icon">
              <SurfaceIcon name={name()} size="small" />
            </span>
          )}
        </Show>
      }
    >
      {(leading) => (
        <span data-slot="surface-list-item-leading">
          <SurfaceNode id={leading()} scope={props.scope} />
        </span>
      )}
    </Show>
  )
}

function ListItemTitle(props: { readonly def: SurfaceNodeProps<"ListItem">["def"]; readonly scope: DataPath }) {
  const runtime = useSurfaceRuntime()
  const read = useSurfaceReader()
  const title = () => read.text(props.def.title, props.scope)
  return (
    <Show
      when={props.def.action}
      fallback={
        <span data-slot="surface-list-item-title" title={title()}>
          {title()}
        </span>
      }
    >
      {(action) => (
        <button
          type="button"
          data-slot="surface-list-item-title"
          data-opens="true"
          title={title()}
          disabled={runtime.actionsDisabled()}
          onClick={() => runtime.fire(action(), props.def.id, props.scope, {})}
        >
          {title()}
        </button>
      )}
    </Show>
  )
}

export function ListItemView(props: SurfaceNodeProps<"ListItem">) {
  const read = useSurfaceReader()
  const repeated = useRepeated()
  const selected = () => boundBoolean(read.value(props.def.selected, props.scope))
  const subtitle = () => read.text(props.def.subtitle, props.scope)
  const identifier = () => read.text(props.def.identifier, props.scope)
  return (
    <div
      data-slot="surface-list-item"
      data-layout={props.def.layout ?? "stacked"}
      data-repeated={repeated ? "true" : "false"}
      data-opens={props.def.action === undefined ? "false" : "true"}
      aria-current={selected() ? "true" : undefined}
    >
      <ListItemLead def={props.def} scope={props.scope} />
      <div data-slot="surface-list-item-body">
        <div data-slot="surface-list-item-text">
          <Show when={identifier()}>{(text) => <span data-slot="surface-list-item-identifier">{text()}</span>}</Show>
          <ListItemTitle def={props.def} scope={props.scope} />
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
