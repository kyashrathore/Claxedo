import type { SurfaceActionEvent } from "@claxedo/plugin-api/surface"
import { unreachable } from "@/lib/machine"

export type SurfaceReplyState = { readonly kind: "idle" } | { readonly kind: "sending" } | { readonly kind: "failed"; readonly message: string }

export type SurfaceReplyEvent = { readonly type: "started" } | { readonly type: "sent" } | { readonly type: "failed"; readonly message: string }

export function surfaceReplyTransition(state: SurfaceReplyState, event: SurfaceReplyEvent): SurfaceReplyState {
  switch (event.type) {
    case "started":
      return { kind: "sending" }
    case "sent":
      return state.kind === "sending" ? { kind: "idle" } : state
    case "failed":
      return state.kind === "sending" ? { kind: "failed", message: event.message } : state
    default:
      return unreachable(event)
  }
}

export function surfaceActionPrompt(title: string, action: SurfaceActionEvent): string {
  return `Surface action ${JSON.stringify(action.name)} on ${JSON.stringify(title)}: ${JSON.stringify(action.context)}`
}
