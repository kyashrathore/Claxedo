import { createSignal, onCleanup, onMount } from "solid-js"
import type { Edge } from "../types"
import { hitTestPaneAt, type DropTarget } from "./drag-drop"
import type { DragController } from "./pointer-drag"

export function createWorkbenchDropTarget(input: {
  drag: DragController
  root: () => HTMLElement | undefined
  commitDrop: (paneId: string, edge: Edge, contentId: string) => void
}) {
  const [dropTarget, setDropTarget] = createSignal<DropTarget | null>(null)
  const clear = () => setDropTarget(null)

  onMount(() => {
    const dispose = input.drag.registerDropZone({
      onMove: (_contentId, x, y) => setDropTarget(hitTestPaneAt(x, y, input.root())),
      onDrop: (contentId, x, y) => {
        const target = hitTestPaneAt(x, y, input.root())
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
