import { clampCoordinate } from "../coordinate"

export type SelectedQuote = { readonly range: Range; readonly quote: string }

export type QuoteBoxPosition = { readonly left: number; readonly width: number } & (
  | { readonly top: number }
  | { readonly bottom: number }
)

type Viewport = { readonly width: number; readonly height: number }

export type Box = Pick<DOMRect, "top" | "bottom" | "left" | "right">

const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable='false'])"
const QUOTE_BOX_WIDTH_PX = 320
const GAP_PX = 8
const QUOTE_BOX_MIN_HEIGHT_PX = 44
const QUOTE_BOX_MAX_HEIGHT_PX = 212

function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement
}

export function insideEditable(node: Node | null | undefined): boolean {
  return !!node && !!elementOf(node)?.closest(EDITABLE)
}

export function selectedQuote(root: HTMLElement, selection: Selection | null): SelectedQuote | undefined {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined
  if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return undefined
  const range = selection.getRangeAt(0)
  if (insideEditable(range.commonAncestorContainer)) return undefined
  const quote = selection.toString().trim()
  return quote ? { range: range.cloneRange(), quote } : undefined
}

export function clippingArea(root: HTMLElement): HTMLElement | undefined {
  for (let element: HTMLElement | null = root; element; element = element.parentElement) {
    if (getComputedStyle(element).overflowY !== "visible") return element
  }
  return undefined
}

export function visibleBounds(area: Box | undefined, viewport: Viewport): Box {
  if (!area) return { top: 0, bottom: viewport.height, left: 0, right: viewport.width }
  return {
    top: Math.max(0, area.top),
    bottom: Math.min(viewport.height, area.bottom),
    left: Math.max(0, area.left),
    right: Math.min(viewport.width, area.right),
  }
}

export function quoteBoxPosition(anchor: Box, bounds: Box, viewport: Viewport): QuoteBoxPosition {
  const width = Math.min(QUOTE_BOX_WIDTH_PX, bounds.right - bounds.left - 2 * GAP_PX)
  const left = clampCoordinate(anchor.left, bounds.left + GAP_PX, bounds.right - width - GAP_PX)
  const below = anchor.bottom + GAP_PX
  if (below + QUOTE_BOX_MAX_HEIGHT_PX <= bounds.bottom - GAP_PX) return { left, width, top: Math.max(bounds.top + GAP_PX, below) }
  const edge = clampCoordinate(anchor.top - GAP_PX, bounds.top + GAP_PX + QUOTE_BOX_MIN_HEIGHT_PX, bounds.bottom - GAP_PX)
  return { left, width, bottom: viewport.height - edge }
}
