/**
 * Multi-pane drag-swap interactions.
 *
 * Provides pointer-based drag tracking for swapping pane leaves.
 * The entire pane header acts as a drag handle. A small dead-zone
 * (5px movement) prevents accidental drags from regular clicks.
 * Tracks cursor position so the renderer can show a floating preview.
 */

import { createSignal, onCleanup, onMount } from "solid-js"
import type { useClaxedoLayout } from "../../context/claxedo-layout"

type Deps = {
  tabId: string
  claxedo: ReturnType<typeof useClaxedoLayout>
}

export type DragPosition = { x: number; y: number }

const DRAG_THRESHOLD = 5

export function createMultiPaneInteractions(deps: Deps) {
  const [moveState, setMoveState] = createSignal<{ id: string } | undefined>()
  const [overState, setOverState] = createSignal<string | undefined>()
  const [dragPos, setDragPos] = createSignal<DragPosition | undefined>()
  /** True once the pointer has moved past the dead-zone threshold. */
  const [dragActive, setDragActive] = createSignal(false)

  let pendingStart: { id: string; x: number; y: number } | undefined

  const startMove = (event: PointerEvent, id: string) => {
    event.preventDefault()
    event.stopPropagation()
    // Don't start immediately — wait for threshold
    pendingStart = { id, x: event.clientX, y: event.clientY }
  }

  onMount(() => {
    const handleMove = (event: PointerEvent) => {
      // Phase 1: haven't committed to drag yet, check threshold
      if (pendingStart && !moveState()) {
        const dx = event.clientX - pendingStart.x
        const dy = event.clientY - pendingStart.y
        if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return
        // Commit to drag
        setMoveState({ id: pendingStart.id })
        setDragActive(true)
        setDragPos({ x: event.clientX, y: event.clientY })
        document.body.style.cursor = "grabbing"
        document.body.style.userSelect = "none"
        return
      }

      const m = moveState()
      if (!m) return

      // Phase 2: actively dragging — update position and detect target
      setDragPos({ x: event.clientX, y: event.clientY })

      const elt = document.elementFromPoint(event.clientX, event.clientY)
      if (!(elt instanceof HTMLElement)) {
        setOverState(undefined)
        return
      }
      const pane = elt.closest("[data-pane]")
      if (!(pane instanceof HTMLElement)) {
        setOverState(undefined)
        return
      }
      const id = pane.dataset.pane
      if (!id || id === m.id) {
        setOverState(undefined)
        return
      }
      setOverState(id)
    }

    const handleUp = () => {
      const m = moveState()
      const id = overState()
      if (m && id) deps.claxedo.multiPane.swap(deps.tabId, m.id, id)
      pendingStart = undefined
      setMoveState(undefined)
      setOverState(undefined)
      setDragPos(undefined)
      setDragActive(false)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    }

    window.addEventListener("pointermove", handleMove)
    window.addEventListener("pointerup", handleUp)
    onCleanup(() => {
      window.removeEventListener("pointermove", handleMove)
      window.removeEventListener("pointerup", handleUp)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    })
  })

  return {
    moveState,
    overState,
    dragPos,
    dragActive,
    startMove,
  }
}
