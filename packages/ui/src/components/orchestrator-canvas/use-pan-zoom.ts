// ---------------------------------------------------------------------------
// Pan/zoom hook — wheel zoom toward cursor, pointer-drag pan, pinch-to-zoom
// ---------------------------------------------------------------------------

import type { CanvasState } from "./types"
import type { CanvasActions } from "./canvas-store"

export interface UsePanZoomOptions {
  store: CanvasState
  actions: CanvasActions
  svgRef: () => SVGSVGElement | undefined
}

export function usePanZoom(options: UsePanZoomOptions) {
  let lastPointerX = 0
  let lastPointerY = 0
  let isPanning = false

  // -- Wheel zoom toward cursor --
  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const svg = options.svgRef()
    if (!svg) return

    const rect = svg.getBoundingClientRect()
    const screenX = e.clientX - rect.left
    const screenY = e.clientY - rect.top
    // Smaller step for trackpad smoothness
    const delta = -e.deltaY * 0.001
    options.actions.zoomToPoint(delta, screenX, screenY)
  }

  // -- Pointer drag for panning --
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    // Don't start pan if clicking on a node
    const target = e.target as Element
    if (target.closest("[data-canvas-node]")) return

    const svg = options.svgRef()
    if (!svg) return

    isPanning = true
    lastPointerX = e.clientX
    lastPointerY = e.clientY
    options.actions.setMode("panning")
    svg.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: PointerEvent) => {
    if (!isPanning) return
    const dx = e.clientX - lastPointerX
    const dy = e.clientY - lastPointerY
    lastPointerX = e.clientX
    lastPointerY = e.clientY
    options.actions.setPan(options.store.pan.x + dx, options.store.pan.y + dy)
  }

  const onPointerUp = (e: PointerEvent) => {
    if (!isPanning) return
    isPanning = false
    options.actions.setMode("idle")
    const svg = options.svgRef()
    if (svg) svg.releasePointerCapture(e.pointerId)
  }

  // -- Touch pinch-to-zoom --
  let lastTouchDist = 0
  let lastTouchMidX = 0
  let lastTouchMidY = 0
  let isTouchZooming = false

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length === 2) {
      e.preventDefault()
      isTouchZooming = true
      const t0 = e.touches[0]
      const t1 = e.touches[1]
      lastTouchDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY)
      const svg = options.svgRef()
      const rect = svg?.getBoundingClientRect()
      if (rect) {
        lastTouchMidX = (t0.clientX + t1.clientX) / 2 - rect.left
        lastTouchMidY = (t0.clientY + t1.clientY) / 2 - rect.top
      }
    }
  }

  const onTouchMove = (e: TouchEvent) => {
    if (!isTouchZooming || e.touches.length !== 2) return
    e.preventDefault()
    const t0 = e.touches[0]
    const t1 = e.touches[1]
    const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY)
    const scale = dist / lastTouchDist
    const delta = (scale - 1) * 0.5

    const svg = options.svgRef()
    const rect = svg?.getBoundingClientRect()
    if (rect) {
      const midX = (t0.clientX + t1.clientX) / 2 - rect.left
      const midY = (t0.clientY + t1.clientY) / 2 - rect.top
      options.actions.zoomToPoint(delta, midX, midY)
      // Also pan to follow midpoint movement
      const dmx = midX - lastTouchMidX
      const dmy = midY - lastTouchMidY
      options.actions.setPan(options.store.pan.x + dmx, options.store.pan.y + dmy)
      lastTouchMidX = midX
      lastTouchMidY = midY
    }
    lastTouchDist = dist
  }

  const onTouchEnd = (e: TouchEvent) => {
    if (e.touches.length < 2) {
      isTouchZooming = false
    }
  }

  return {
    onWheel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
  }
}
