import { createEffect, createMemo, Show } from "solid-js"
import { surfaceImageUrl } from "@claxedo/plugin-api/surface"
import type { SurfaceNodeProps } from "../model"
import { RowActionRoleProvider } from "./row-actions"
import { SurfaceGroup } from "./surface-children"
import { SurfaceIcon } from "./surface-icon"
import { useSurfaceReader, useSurfaceRuntime } from "./surface-runtime"

function Picture(props: SurfaceNodeProps<"Image">) {
  const runtime = useSurfaceRuntime()
  const read = useSurfaceReader()
  const label = () => read.text(props.def.accessibility.label, props.scope)
  const checked = createMemo(() => surfaceImageUrl(read.text(props.def.url, props.scope), location.origin))
  const url = () => {
    const current = checked()
    return current.ok ? current.url : undefined
  }
  createEffect(() => {
    const current = checked()
    if (!current.ok) runtime.reportOnce(props.def.id, "A surface Image was refused and is not drawn", { reason: current.reason })
  })
  return (
    <Show
      when={url()}
      fallback={
        <span data-slot="surface-image-refused" data-variant={props.def.variant ?? "auto"} role="img" aria-label={label()}>
          <SurfaceIcon name="photo" size="small" />
          <span data-slot="surface-image-refused-label">{label()}</span>
        </span>
      }
    >
      {(source) => <img data-slot="surface-image" data-fit={props.def.fit ?? "contain"} data-variant={props.def.variant ?? "auto"} src={source()} alt={label()} title={label()} />}
    </Show>
  )
}

export function ImageView(props: SurfaceNodeProps<"Image">) {
  return (
    <Show when={(props.def.actions?.length ?? 0) > 0} fallback={<Picture def={props.def} scope={props.scope} />}>
      <span data-slot="surface-image-frame" data-variant={props.def.variant ?? "auto"}>
        <Picture def={props.def} scope={props.scope} />
        <RowActionRoleProvider value="row-secondary">
          <SurfaceGroup ids={props.def.actions} scope={props.scope} slot="surface-image-actions" />
        </RowActionRoleProvider>
      </span>
    </Show>
  )
}
