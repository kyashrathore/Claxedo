// ---------------------------------------------------------------------------
// Canvas state store — SolidJS createStore with actions
// ---------------------------------------------------------------------------

import { createStore, produce } from "solid-js/store"
import type { CanvasState } from "./types"
import { ZOOM_MIN, ZOOM_MAX, ZOOM_STEP } from "./types"

export interface CanvasActions {
  setPan(x: number, y: number): void
  setZoom(zoom: number): void
  zoomIn(): void
  zoomOut(): void
  zoomToPoint(delta: number, screenX: number, screenY: number): void
  fitToView(contentWidth: number, contentHeight: number, viewportWidth: number, viewportHeight: number): void
  selectNode(id: string | null): void
  toggleNodeExpanded(id: string): void
  setNodeOverride(id: string, x: number, y: number): void
  clearNodeOverride(id: string): void
  resetLayout(): void
  togglePause(): void
  setPaused(paused: boolean): void
  setMode(mode: CanvasState["mode"]): void
  setAnimateTransform(animate: boolean): void
}

export function createCanvasStore(): [CanvasState, CanvasActions] {
  const [store, setStore] = createStore<CanvasState>({
    pan: { x: 0, y: 0 },
    zoom: 1,
    mode: "idle",
    selectedNodeId: null,
    expandedNodeIds: [],
    nodeOverrides: {},
    paused: false,
    animateTransform: false,
    layoutVersion: 0,
  })

  const actions: CanvasActions = {
    setPan(x, y) {
      setStore("pan", { x, y })
    },

    setZoom(zoom) {
      setStore("zoom", Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom)))
    },

    zoomIn() {
      actions.setZoom(store.zoom + ZOOM_STEP)
    },

    zoomOut() {
      actions.setZoom(store.zoom - ZOOM_STEP)
    },

    zoomToPoint(delta, screenX, screenY) {
      const oldZoom = store.zoom
      const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, oldZoom + delta))
      if (newZoom === oldZoom) return

      // Keep the point under the cursor stable:
      // canvasX = (screenX - panX) / oldZoom
      // newPanX = screenX - canvasX * newZoom
      const canvasX = (screenX - store.pan.x) / oldZoom
      const canvasY = (screenY - store.pan.y) / oldZoom
      const newPanX = screenX - canvasX * newZoom
      const newPanY = screenY - canvasY * newZoom

      setStore(produce((s) => {
        s.zoom = newZoom
        s.pan.x = newPanX
        s.pan.y = newPanY
      }))
    },

    fitToView(contentWidth, contentHeight, viewportWidth, viewportHeight) {
      if (contentWidth === 0 || contentHeight === 0) return
      const scaleX = viewportWidth / contentWidth
      const scaleY = viewportHeight / contentHeight
      const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.min(scaleX, scaleY) * 0.9))
      const panX = (viewportWidth - contentWidth * zoom) / 2
      const panY = (viewportHeight - contentHeight * zoom) / 2

      setStore(produce((s) => {
        s.animateTransform = true
        s.zoom = zoom
        s.pan.x = panX
        s.pan.y = panY
      }))
      // Turn off animation after CSS transition completes
      setTimeout(() => setStore("animateTransform", false), 350)
    },

    selectNode(id) {
      setStore("selectedNodeId", id)
    },

    toggleNodeExpanded(id) {
      setStore("expandedNodeIds", (prev) =>
        prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
      )
    },

    setNodeOverride(id, x, y) {
      setStore("nodeOverrides", id, { x, y })
    },

    clearNodeOverride(id) {
      setStore(
        "nodeOverrides",
        produce((o: Record<string, any>) => {
          delete o[id]
        }),
      )
    },

    resetLayout() {
      setStore(produce((s) => {
        // Clear all drag overrides — nodes snap back to computed positions
        s.nodeOverrides = {} as any
        // Bump version to force layout recomputation with new candidate orderings
        s.layoutVersion++
      }))
    },

    togglePause() {
      setStore("paused", (p) => !p)
    },

    setPaused(paused) {
      setStore("paused", paused)
    },

    setMode(mode) {
      setStore("mode", mode)
    },

    setAnimateTransform(animate) {
      setStore("animateTransform", animate)
    },
  }

  return [store, actions]
}
