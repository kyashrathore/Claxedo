import { createSignal, type Accessor } from "solid-js"

export type DragSourceKind = "workbench-pane" | "tab" | "navigation-row"

export type DropZone = {
  onMove?: (contentId: string, x: number, y: number) => void
  onDrop?: (contentId: string, x: number, y: number) => boolean | void
  onCancel?: () => void
}

type DragState = {
  active: boolean
  contentId: string | null
  sourceKind: DragSourceKind | null
  x: number
  y: number
}

export type DragBegin = { contentId: string; sourceKind: DragSourceKind; x: number; y: number; label?: string }

export type DragController = {
  readonly active: Accessor<boolean>
  readonly contentId: Accessor<string | null>
  readonly sourceKind: Accessor<DragSourceKind | null>
  readonly registerDropZone: (zone: DropZone) => () => void
  readonly begin: (input: DragBegin) => void
  readonly move: (x: number, y: number) => void
  readonly end: () => boolean
  readonly cancel: () => void
}

const idle: DragState = { active: false, contentId: null, sourceKind: null, x: 0, y: 0 }

function createGhost(): HTMLElement {
  const ghost = document.createElement("div")
  ghost.setAttribute("data-testid", "workbench-drag-ghost")
  ghost.className = "workbench-drag-ghost"
  ghost.style.transform = "translate(-9999px, -9999px)"
  document.body.appendChild(ghost)
  return ghost
}

export function createDragController(): DragController {
  const [state, setState] = createSignal<DragState>(idle)
  const dropZones: DropZone[] = []
  let ghost: HTMLElement | null = null

  const showGhost = (label: string, x: number, y: number) => {
    if (typeof document === "undefined") return
    ghost ??= createGhost()
    ghost.textContent = label
    ghost.style.transform = `translate(${x + 12}px, ${y + 12}px)`
  }
  const removeGhost = () => {
    ghost?.remove()
    ghost = null
  }

  return {
    active: () => state().active,
    contentId: () => state().contentId,
    sourceKind: () => state().sourceKind,
    registerDropZone(zone) {
      dropZones.push(zone)
      return () => {
        const index = dropZones.indexOf(zone)
        if (index >= 0) dropZones.splice(index, 1)
      }
    },
    begin(input) {
      setState({ active: true, contentId: input.contentId, sourceKind: input.sourceKind, x: input.x, y: input.y })
      showGhost(input.label ?? "", input.x, input.y)
      for (const zone of dropZones.slice()) zone.onMove?.(input.contentId, input.x, input.y)
    },
    move(x, y) {
      const current = state()
      if (!current.active || current.contentId == null) return
      setState({ ...current, x, y })
      if (ghost) ghost.style.transform = `translate(${x + 12}px, ${y + 12}px)`
      for (const zone of dropZones.slice()) zone.onMove?.(current.contentId, x, y)
    },
    end() {
      const current = state()
      if (!current.active) return false
      setState({ ...current, active: false })
      removeGhost()
      if (current.contentId == null) return false
      let consumed = false
      for (const zone of dropZones.slice()) {
        if (zone.onDrop?.(current.contentId, current.x, current.y) === true) consumed = true
      }
      return consumed
    },
    cancel() {
      const current = state()
      if (!current.active) return
      setState({ ...current, active: false })
      removeGhost()
      for (const zone of dropZones.slice()) zone.onCancel?.()
    },
  }
}
