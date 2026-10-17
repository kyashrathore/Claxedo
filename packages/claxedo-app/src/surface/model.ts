import type { Accessor } from "solid-js"
import type { SurfaceActionEvent, SurfaceComponent, SurfaceMessage } from "@claxedo/plugin-api/surface"
import { unreachable } from "@/lib/machine"

export type SurfaceSource = { readonly kind: "agent"; readonly label: string } | { readonly kind: "plugin"; readonly label: string }

export class SurfaceMessageError extends Error {
  override name = "SurfaceMessageError"
}

export type SurfaceLifecycle = { readonly kind: "waiting" } | { readonly kind: "live" } | { readonly kind: "deleted" }

export type SurfaceLifecycleEvent = { readonly type: "created" } | { readonly type: "deleted" }

export function surfaceLifecycle(state: SurfaceLifecycle, event: SurfaceLifecycleEvent): SurfaceLifecycle {
  switch (event.type) {
    case "created":
      return state.kind === "live" ? state : { kind: "live" }
    case "deleted":
      return state.kind === "waiting" ? state : { kind: "deleted" }
    default:
      return unreachable(event)
  }
}

export type DataPath = readonly string[]

export type JsonValue = SurfaceActionEvent["context"][string]

export type SurfaceData = {
  readonly read: (path: DataPath) => unknown
  readonly write: (path: DataPath, value: JsonValue | undefined) => void
  readonly snapshot: (path: DataPath) => JsonValue | undefined
  readonly clear: () => void
}

export type SurfaceComponents = {
  readonly get: (id: string) => SurfaceComponent | undefined
  readonly upsert: (components: readonly SurfaceComponent[]) => void
  readonly clear: () => void
}

export type SurfaceState = {
  readonly lifecycle: Accessor<SurfaceLifecycle>
  readonly components: SurfaceComponents
  readonly data: SurfaceData
}

export const surfaceState: unique symbol = Symbol("surfaceState")

export type Surface = {
  readonly surfaceId: string
  apply(message: SurfaceMessage): void
  readonly [surfaceState]: SurfaceState
}

export type SurfaceNodeProps<Name extends SurfaceComponent["component"]> = {
  readonly def: Extract<SurfaceComponent, { component: Name }>
  readonly scope: DataPath
}
