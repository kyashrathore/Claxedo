import { createSignal, onCleanup, onMount } from "solid-js"
import type { Edge } from "../types"
import { hitTestPaneAt, type DropTarget } from "./drag-drop"
import type { DragController } from "./pointer-drag"

export function createWorkbenchDropTarget(input: {
  drag: DragController
  root: () => HTMLElement | undefined
  accepts: (paneId: string, contentId: string) => boolean
  commitDrop: (paneId: string, edge: Edge, contentId: string) => void
}) {
  const [dropTarget, setDropTarget] = createSignal<DropTarget | null>(null)
  const clear = () => setDropTarget(null)
  const targetAt = (contentId: string, x: number, y: number) => {
    const target = hitTestPaneAt(x, y, input.root())
    return target && input.accepts(target.paneId, contentId) ? target : null
  }

  onMount(() => {
    const dispose = input.drag.registerDropZone({
      onMove: (contentId, x, y) => setDropTarget(targetAt(contentId, x, y)),
      onDrop: (contentId, x, y) => {
        const target = targetAt(contentId, x, y)
        clear()
        if (!target) return false
        input.commitDrop(target.paneId, target.edge, contentId)
        return true
      },
      onCancel: clear,
    })
    onCleanup(dispose)
  })

  return dropTarget
}
