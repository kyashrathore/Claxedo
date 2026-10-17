import { createMemo, For, Index, Match, Show, Switch } from "solid-js"
import type { SurfaceChildList } from "@claxedo/plugin-api/surface"
import { itemScope, resolvePath } from "../data-path"
import type { DataPath } from "../model"
import { SurfaceNode } from "./surface-node"
import { useSurfaceRuntime } from "./surface-runtime"

type ChildTemplate = Exclude<SurfaceChildList, readonly string[]>

const NO_ITEMS: readonly unknown[] = []

function SurfaceChild(props: { readonly id: string; readonly scope: DataPath; readonly weighted: boolean }) {
  const runtime = useSurfaceRuntime()
  const weight = () => (props.weighted ? runtime.state.components.get(props.id)?.weight : undefined)
  return (
    <Show when={weight() !== undefined} fallback={<SurfaceNode id={props.id} scope={props.scope} />}>
      <div data-slot="surface-weighted" style={{ "flex-grow": String(weight()) }}>
        <SurfaceNode id={props.id} scope={props.scope} />
      </div>
    </Show>
  )
}

function SurfaceTemplate(props: { readonly template: ChildTemplate; readonly scope: DataPath; readonly weighted: boolean }) {
  const runtime = useSurfaceRuntime()
  const listPath = createMemo(() => resolvePath(props.template.path, props.scope))
  const items = () => {
    const value = runtime.state.data.read(listPath())
    return Array.isArray(value) ? value : NO_ITEMS
  }
  return (
    <Index each={items()}>
      {(_, index) => <SurfaceChild id={props.template.componentId} scope={itemScope(listPath(), index)} weighted={props.weighted} />}
    </Index>
  )
}

function childIds(list: SurfaceChildList): readonly string[] | undefined {
  return Array.isArray(list) ? list : undefined
}

function childTemplate(list: SurfaceChildList): ChildTemplate | undefined {
  return Array.isArray(list) ? undefined : list
}

export function SurfaceChildren(props: { readonly list: SurfaceChildList; readonly scope: DataPath; readonly weighted: boolean }) {
  return (
    <Switch>
      <Match when={childIds(props.list)}>
        {(ids) => <For each={ids()}>{(id) => <SurfaceChild id={id} scope={props.scope} weighted={props.weighted} />}</For>}
      </Match>
      <Match when={childTemplate(props.list)}>
        {(template) => <SurfaceTemplate template={template()} scope={props.scope} weighted={props.weighted} />}
      </Match>
    </Switch>
  )
}
