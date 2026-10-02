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

function ghostTransform(x: number, y: number): string {
  return `translate(${x + 12}px, ${y + 12}px)`
}

function createDragGhost() {
  let ghost: HTMLElement | null = null
  return {
    show(label: string, x: number, y: number) {
      if (typeof document === "undefined") return
      if (!ghost) {
        ghost = document.createElement("div")
        ghost.setAttribute("data-testid", "workbench-drag-ghost")
        ghost.className = "workbench-drag-ghost"
        document.body.appendChild(ghost)
      }
      ghost.textContent = label
      ghost.style.transform = ghostTransform(x, y)
    },
    move(x: number, y: number) {
      if (ghost) ghost.style.transform = ghostTransform(x, y)
    },
    remove() {
      ghost?.remove()
      ghost = null
    },
  }
}

function createDropZones() {
  const zones: DropZone[] = []
  return {
    register: (zone: DropZone) => {
      zones.push(zone)
      return () => {
        const index = zones.indexOf(zone)
        if (index >= 0) zones.splice(index, 1)
      }
    },
    each: (visit: (zone: DropZone) => void) => zones.slice().forEach(visit),
  }
}

type DropZones = ReturnType<typeof createDropZones>

function dropOn(zones: DropZones, current: DragState): boolean {
  const contentId = current.contentId
  if (contentId == null) return false
  let consumed = false
  zones.each((zone) => {
    if (zone.onDrop?.(contentId, current.x, current.y) === true) consumed = true
  })
  return consumed
}

export function createDragController(): DragController {
  const [state, setState] = createSignal(idle)
  const zones = createDropZones()
  const ghost = createDragGhost()
  const stop = (current: DragState) => {
    setState({ ...current, active: false })
    ghost.remove()
  }
  return {
    active: () => state().active,
    contentId: () => state().contentId,
    sourceKind: () => state().sourceKind,
    registerDropZone: zones.register,
    begin(input) {
      setState({ active: true, contentId: input.contentId, sourceKind: input.sourceKind, x: input.x, y: input.y })
      ghost.show(input.label ?? "", input.x, input.y)
      zones.each((zone) => zone.onMove?.(input.contentId, input.x, input.y))
    },
    move(x, y) {
      const current = state()
      const contentId = current.contentId
      if (!current.active || contentId == null) return
      setState({ ...current, x, y })
      ghost.move(x, y)
      zones.each((zone) => zone.onMove?.(contentId, x, y))
    },
    end() {
      const current = state()
      if (!current.active) return false
      stop(current)
      return dropOn(zones, current)
    },
    cancel() {
      const current = state()
      if (!current.active) return
      stop(current)
      zones.each((zone) => zone.onCancel?.())
    },
  }
}
