import type { JSX } from "solid-js"
import type { PaneRect } from "./types"

export function contentSlotStyle(input: {
  paneId: string | null
  rect: PaneRect | undefined
  visible: boolean
  preparing: boolean
}): JSX.CSSProperties {
  if (!input.paneId) {
    // Display-lock stashed surfaces so they retain rendering state without
    // participating in whole-document style recalculation or hit testing.
    return {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      opacity: "0",
      visibility: "hidden",
      "content-visibility": "hidden",
      contain: "strict",
      "pointer-events": "none",
      overflow: "hidden",
    }
  }
  if (!input.rect) return { display: "none" }

  const geometry: JSX.CSSProperties = {
    position: "absolute",
    left: `${input.rect.left * 100}%`,
    top: `${input.rect.top * 100}%`,
    width: `${input.rect.width * 100}%`,
    height: `${input.rect.height * 100}%`,
    display: "block",
    overflow: "hidden",
    contain: "strict",
    "background-color": "var(--background-base)",
  }
  if (input.preparing) {
    // The destination uses its final geometry behind the opaque source until
    // it reports its first fold ready.
    return { ...geometry, "z-index": "1", "pointer-events": "none" }
  }
  if (input.visible) return { ...geometry, "z-index": "2" }

  // Unlike display:none, display locking preserves the cached layout that
  // makes an already-mounted pane cheap to reveal again.
  return {
    ...geometry,
    "content-visibility": "hidden",
    "z-index": "0",
    "pointer-events": "none",
  }
}
