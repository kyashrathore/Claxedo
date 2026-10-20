import { unreachable } from "@/lib/machine"

export type RichTextMode =
  | { readonly kind: "loading" }
  | { readonly kind: "rich" }
  | { readonly kind: "source"; readonly reason: "markdown" | "failed"; readonly rechecked: boolean }

export type RichTextModeEvent =
  | { readonly type: "loaded"; readonly fits: boolean }
  | { readonly type: "loadFailed" }
  | { readonly type: "valueReplaced"; readonly fits: boolean }
  | { readonly type: "rechecked"; readonly fits: boolean }

export function richTextModeTransition(state: RichTextMode, event: RichTextModeEvent): RichTextMode {
  switch (event.type) {
    case "loaded":
      return state.kind === "loading" ? (event.fits ? { kind: "rich" } : { kind: "source", reason: "markdown", rechecked: false }) : state
    case "loadFailed":
      return { kind: "source", reason: "failed", rechecked: false }
    case "valueReplaced":
      if (state.kind === "loading" || (state.kind === "source" && state.reason === "failed")) return state
      return event.fits ? { kind: "rich" } : { kind: "source", reason: "markdown", rechecked: false }
    case "rechecked":
      if (state.kind !== "source" || state.reason === "failed") return state
      return event.fits ? { kind: "rich" } : { ...state, rechecked: true }
    default:
      return unreachable(event)
  }
}
