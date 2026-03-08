// ---------------------------------------------------------------------------
// Node drag hook — pointer capture, delta adjusted for zoom, store override
// ---------------------------------------------------------------------------

import type { CanvasState } from "./types"
import type { CanvasActions } from "./canvas-store"

export interface UseNodeDragOptions {
  store: CanvasState
  actions: CanvasActions
  svgRef: () => SVGSVGElement | undefined
}

export function useNodeDrag(options: UseNodeDragOptions) {
  let dragging = false
  let dragNodeId: string | null = null
  let startCanvasX = 0
  let startCanvasY = 0
  let startNodeX = 0
  let startNodeY = 0

  const onNodePointerDown = (
    e: PointerEvent,
    nodeId: string,
    nodeX: number,
    nodeY: number,
  ) => {
    e.stopPropagation()
    e.preventDefault()

    dragging = true
    dragNodeId = nodeId
    options.actions.setMode("dragging-node")

    const svg = options.svgRef()
    const rect = svg?.getBoundingClientRect()
    if (!rect) return

    startCanvasX = (e.clientX - rect.left - options.store.pan.x) / options.store.zoom
    startCanvasY = (e.clientY - rect.top - options.store.pan.y) / options.store.zoom
    startNodeX = nodeX
    startNodeY = nodeY

    const target = e.currentTarget as Element
    target.setPointerCapture(e.pointerId)
  }

  const onNodePointerMove = (e: PointerEvent) => {
    if (!dragging || !dragNodeId) return

    const svg = options.svgRef()
    const rect = svg?.getBoundingClientRect()
    if (!rect) return

    const canvasX = (e.clientX - rect.left - options.store.pan.x) / options.store.zoom
    const canvasY = (e.clientY - rect.top - options.store.pan.y) / options.store.zoom
    const dx = canvasX - startCanvasX
    const dy = canvasY - startCanvasY

    options.actions.setNodeOverride(dragNodeId, startNodeX + dx, startNodeY + dy)
  }

  const onNodePointerUp = (e: PointerEvent) => {
    if (!dragging) return
    dragging = false
    dragNodeId = null
    options.actions.setMode("idle")

    const target = e.currentTarget as Element
    target.releasePointerCapture(e.pointerId)
  }

  return {
    onNodePointerDown,
    onNodePointerMove,
    onNodePointerUp,
  }
}
