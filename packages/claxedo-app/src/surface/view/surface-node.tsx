import { createMemo, Show, type Component } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { SurfaceComponent } from "@claxedo/plugin-api/surface"
import type { DataPath } from "../model"
import { SURFACE_VIEWS } from "./component-views"
import { useSurfaceRuntime } from "./surface-runtime"

type AnySurfaceView = Component<{ def: SurfaceComponent; scope: DataPath }>

export function SurfaceNode(props: { readonly id: string; readonly scope: DataPath }) {
  const runtime = useSurfaceRuntime()
  const definition = () => runtime.state.components.get(props.id)
  const view = createMemo(() => {
    const name = definition()?.component
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    return name === undefined ? undefined : (SURFACE_VIEWS[name] as AnySurfaceView)
  })
  return (
    <Show when={definition()}>
      {(def) => <Dynamic component={view()} def={def()} scope={props.scope} />}
    </Show>
  )
}
