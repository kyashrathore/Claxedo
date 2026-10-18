import { Show, type JSX } from "solid-js"
import { SURFACE_ROOT_ID, type SurfaceActionEvent } from "@claxedo/plugin-api/surface"
import { surfaceActionEvent } from "../action"
import { ROOT_PATH } from "../data-path"
import { surfaceState, type Surface, type SurfaceSource, type SurfaceState } from "../model"
import { SurfaceNode } from "./surface-node"
import { SurfaceSourceMark } from "./surface-source-mark"
import { SurfaceRuntimeProvider, type SurfaceRuntime } from "./surface-runtime"
import "./surface.css"
import "./surface-layout.css"
import "./surface-fields.css"
import "./surface-display.css"

export type SurfaceViewProps = {
  readonly surface: Surface
  readonly source: SurfaceSource
  readonly onAction?: (action: SurfaceActionEvent) => void
  readonly actionsDisabled?: boolean
}

export function SurfaceView(props: SurfaceViewProps): JSX.Element {
  const state = (): SurfaceState => props.surface[surfaceState]
  const runtime: SurfaceRuntime = {
    get state() {
      return state()
    },
    actionsDisabled: () => props.actionsDisabled === true || props.onAction === undefined,
    fire: (action, sourceComponentId, scope) => {
      const event = surfaceActionEvent(action, { surfaceId: props.surface.surfaceId, sourceComponentId, scope }, state().data, new Date())
      props.onAction?.(event)
    },
  }
  const drawn = () => state().lifecycle().kind === "live" && state().components.get(SURFACE_ROOT_ID) !== undefined
  return (
    <Show when={drawn()}>
      <section data-component="surface" data-source={props.source.kind} data-claxedo-compact-touch aria-label={props.source.label}>
        <SurfaceSourceMark source={props.source} />
        <SurfaceRuntimeProvider value={runtime}>
          <SurfaceNode id={SURFACE_ROOT_ID} scope={ROOT_PATH} />
        </SurfaceRuntimeProvider>
      </section>
    </Show>
  )
}
