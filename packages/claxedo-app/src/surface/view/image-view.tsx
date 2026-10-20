import { createEffect, createMemo, Show } from "solid-js"
import { surfaceImageUrl } from "@claxedo/plugin-api/surface"
import type { SurfaceNodeProps } from "../model"
import { SurfaceIcon } from "./surface-icon"
import { useSurfaceReader, useSurfaceRuntime } from "./surface-runtime"

export function ImageView(props: SurfaceNodeProps<"Image">) {
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
      {(source) => <img data-slot="surface-image" data-fit={props.def.fit ?? "contain"} data-variant={props.def.variant ?? "auto"} src={source()} alt={label()} />}
    </Show>
  )
}
