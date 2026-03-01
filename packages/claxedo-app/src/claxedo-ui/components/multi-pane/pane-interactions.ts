/**
 * Multi-pane drag-swap interactions.
 *
 * Provides drag-and-drop swap logic for generic pane leaves.
 */

import { createSignal, onCleanup, onMount } from "solid-js"
import type { useClaxedoLayout } from "../../context/claxedo-layout"

type Deps = {
  tabId: string
  claxedo: ReturnType<typeof useClaxedoLayout>
}

export function createMultiPaneInteractions(deps: Deps) {
  const [moveState, setMoveState] = createSignal<{ id: string } | undefined>()
  const [overState, setOverState] = createSignal<string | undefined>()

  const startMove = (event: PointerEvent, id: string) => {
    event.preventDefault()
    event.stopPropagation()
    setMoveState({ id })
  }

  onMount(() => {
    const handleMove = (event: PointerEvent) => {
      const m = moveState()
      if (!m) return
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
      setMoveState(undefined)
      setOverState(undefined)
    }

    window.addEventListener("pointermove", handleMove)
    window.addEventListener("pointerup", handleUp)
    onCleanup(() => {
      window.removeEventListener("pointermove", handleMove)
      window.removeEventListener("pointerup", handleUp)
    })
  })

  return {
    moveState,
    overState,
    startMove,
  }
}
