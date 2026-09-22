import { createSignal, onCleanup, onMount } from "solid-js"

import { hitTestPaneAt, type DropTarget } from "./drag-drop"
import { workbenchDrag } from "./pointer-drag"
import type { Edge } from "./types"

/**
 * The workbench's own drop zone, driven by the pointer-drag controller (mouse,
 * touch and pen alike). The controller feeds the live pointer position; this
 * hit-tests the panes under it, drives the edge overlay, and commits the split.
 */
export function createWorkbenchDropTarget(input: {
  root: () => HTMLElement | undefined
  commitDrop: (paneId: string, edge: Edge, contentId: string) => void
}) {
  const [dropTarget, setDropTarget] = createSignal<DropTarget | null>(null)
  const clear = () => setDropTarget(null)

  onMount(() => {
    const dispose = workbenchDrag.registerDropZone({
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
