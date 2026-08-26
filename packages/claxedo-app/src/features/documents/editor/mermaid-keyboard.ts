// Keyboard contract for the mermaid diagram pan/zoom viewport. Pointer/wheel
// interaction lives in mermaid-block.ts; this pure mapper defines the
// keyboard-only equivalents so a keyboard user can zoom and pan a diagram, and
// so that contract is testable without a DOM.

export type MermaidViewAction =
  { type: "zoom"; factor: number } | { type: "pan"; dx: number; dy: number } | { type: "reset" }

export const MERMAID_ZOOM_IN_FACTOR = 1.1
export const MERMAID_ZOOM_OUT_FACTOR = 1 / 1.1
export const MERMAID_PAN_STEP = 40

/**
 * Map a KeyboardEvent `key` to a pan/zoom view action, or null when the key is
 * not a mermaid control. `+`/`=` zoom in, `-`/`_` zoom out, `0` resets, and the
 * arrow keys pan the diagram in the arrow's direction (like scrolling).
 */
export function mermaidKeyAction(key: string, panStep = MERMAID_PAN_STEP): MermaidViewAction | null {
  switch (key) {
    case "+":
    case "=":
      return { type: "zoom", factor: MERMAID_ZOOM_IN_FACTOR }
    case "-":
    case "_":
      return { type: "zoom", factor: MERMAID_ZOOM_OUT_FACTOR }
    case "0":
      return { type: "reset" }
    case "ArrowUp":
      return { type: "pan", dx: 0, dy: panStep }
    case "ArrowDown":
      return { type: "pan", dx: 0, dy: -panStep }
    case "ArrowLeft":
      return { type: "pan", dx: panStep, dy: 0 }
    case "ArrowRight":
      return { type: "pan", dx: -panStep, dy: 0 }
    default:
      return null
  }
}
