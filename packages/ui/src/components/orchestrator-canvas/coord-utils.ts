// ---------------------------------------------------------------------------
// Coordinate conversion utilities for canvas pan/zoom
// ---------------------------------------------------------------------------

/** Convert screen (pixel) coordinates to canvas (SVG content) coordinates */
export function screenToCanvas(
  screenX: number,
  screenY: number,
  pan: { x: number; y: number },
  zoom: number,
  svgRect: DOMRect,
): { x: number; y: number } {
  return {
    x: (screenX - svgRect.left - pan.x) / zoom,
    y: (screenY - svgRect.top - pan.y) / zoom,
  }
}

/** Convert canvas (SVG content) coordinates to screen (pixel) coordinates */
export function canvasToScreen(
  canvasX: number,
  canvasY: number,
  pan: { x: number; y: number },
  zoom: number,
  svgRect: DOMRect,
): { x: number; y: number } {
  return {
    x: canvasX * zoom + pan.x + svgRect.left,
    y: canvasY * zoom + pan.y + svgRect.top,
  }
}
