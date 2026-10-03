import { unreachable } from "@/lib/machine"

export type ActivityFilterState =
  | { readonly kind: "all" }
  | { readonly kind: "working" }
  | { readonly kind: "needs-you" }

export type ActivityFilterEvent = { readonly type: "cycled" } | { readonly type: "reset" }

export function activityFilterTransition(state: ActivityFilterState, event: ActivityFilterEvent): ActivityFilterState {
  switch (event.type) {
    case "reset": return state.kind === "all" ? state : { kind: "all" }
    case "cycled": {
      switch (state.kind) {
        case "all": return { kind: "working" }
        case "working": return { kind: "needs-you" }
        case "needs-you": return { kind: "all" }
        default: return unreachable(state)
      }
    }
    default: return unreachable(event)
  }
}
