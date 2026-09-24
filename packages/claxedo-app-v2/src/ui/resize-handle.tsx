import { splitProps, type JSX } from "solid-js"
import "./resize-handle.css"

export interface ResizeHandleProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "onResize"> {
  direction: "horizontal" | "vertical"
  edge?: "start" | "end"
  size: number
  min: number
  max: number
  onResize: (size: number) => void
  onCollapse?: () => void
  onCollapseChange?: (collapsed: boolean) => void
  collapseThreshold?: number
}

type Drag = Pick<ResizeHandleProps, "direction" | "size" | "min" | "max" | "onResize" | "onCollapse" | "onCollapseChange"> & {
  edge: "start" | "end"
  threshold: number
  origin: number
}

const positionOf = (event: PointerEvent, direction: Drag["direction"]) => (direction === "horizontal" ? event.clientX : event.clientY)

const deltaOf = (drag: Drag, position: number) => {
  const grows = drag.direction === "vertical" ? drag.edge === "end" : drag.edge === "end"
  return grows ? position - drag.origin : drag.origin - position
}

function track(handle: HTMLElement, drag: Drag, pointerId: number) {
  const state = { collapsed: false }
  document.body.style.userSelect = "none"
  document.body.style.overflow = "hidden"
  handle.setPointerCapture(pointerId)

  const onMove = (event: PointerEvent) => {
    const size = drag.size + deltaOf(drag, positionOf(event, drag.direction))
    const collapsed = drag.threshold > 0 && size < drag.threshold
    if (collapsed !== state.collapsed) {
      state.collapsed = collapsed
      drag.onCollapseChange?.(collapsed)
    }
    drag.onResize(Math.min(drag.max, Math.max(drag.min, size)))
  }

  const onEnd = () => {
    document.body.style.userSelect = ""
    document.body.style.overflow = ""
    handle.removeEventListener("pointermove", onMove)
    handle.removeEventListener("pointerup", onEnd)
    handle.removeEventListener("pointercancel", onEnd)
    if (state.collapsed) drag.onCollapse?.()
    else drag.onCollapseChange?.(false)
  }

  handle.addEventListener("pointermove", onMove)
  handle.addEventListener("pointerup", onEnd)
  handle.addEventListener("pointercancel", onEnd)
}

export function ResizeHandle(props: ResizeHandleProps) {
  const [local, rest] = splitProps(props, [
    "direction",
    "edge",
    "size",
    "min",
    "max",
    "onResize",
    "onCollapse",
    "onCollapseChange",
    "collapseThreshold",
    "class",
    "classList",
  ])
  const edge = () => local.edge ?? (local.direction === "vertical" ? "start" : "end")

  const onPointerDown = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (event.button !== 0 && event.pointerType === "mouse") return
    event.preventDefault()
    track(
      event.currentTarget,
      {
        direction: local.direction,
        edge: edge(),
        size: local.size,
        min: local.min,
        max: local.max,
        threshold: local.collapseThreshold ?? 0,
        origin: positionOf(event, local.direction),
        onResize: local.onResize,
        onCollapse: local.onCollapse,
        onCollapseChange: local.onCollapseChange,
      },
      event.pointerId,
    )
  }

  return (
    <div
      {...rest}
      data-component="resize-handle"
      data-direction={local.direction}
      data-edge={edge()}
      classList={{ "ui-resize-handle": true, ...local.classList, [local.class ?? ""]: !!local.class }}
      onPointerDown={onPointerDown}
    />
  )
}
