import { machine, unreachable } from "@/lib/machine"

export type SurfacePageState = { readonly kind: "open" } | { readonly kind: "failed"; readonly error: Error } | { readonly kind: "closed" }

export type SurfacePageEvent = { readonly type: "failed"; readonly error: Error } | { readonly type: "closed" }

export function surfacePageTransition(state: SurfacePageState, event: SurfacePageEvent): SurfacePageState {
  switch (event.type) {
    case "failed":
      return state.kind === "open" ? { kind: "failed", error: event.error } : state
    case "closed":
      return { kind: "closed" }
    default:
      return unreachable(event)
  }
}

export function surfacePageMachine() {
  return machine<SurfacePageState, SurfacePageEvent>({ kind: "open" }, surfacePageTransition)
}
