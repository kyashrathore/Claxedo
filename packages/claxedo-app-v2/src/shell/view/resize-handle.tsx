import type { JSX } from "solid-js"

const KEYBOARD_STEP = 16

export function ResizeHandle(props: {
  readonly label: string
  readonly edge: "left" | "right"
  readonly width: () => number
  readonly min: number
  readonly max: number
  readonly onResize: (width: number) => void
}): JSX.Element {
  const onPointerDown = (event: PointerEvent) => {
    const startX = event.clientX
    const startWidth = props.width()
    const direction = props.edge === "right" ? 1 : -1
    const onMove = (move: PointerEvent) => props.onResize(startWidth + (move.clientX - startX) * direction)
    const onUp = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    event.preventDefault()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    const grow = props.edge === "right" ? "ArrowRight" : "ArrowLeft"
    const shrink = props.edge === "right" ? "ArrowLeft" : "ArrowRight"
    let next: number | undefined
    if (event.key === grow) next = props.width() + KEYBOARD_STEP
    else if (event.key === shrink) next = props.width() - KEYBOARD_STEP
    else if (event.key === "Home") next = props.min
    else if (event.key === "End") next = props.max
    if (next === undefined) return
    event.preventDefault()
    props.onResize(next)
  }
  return (
    <div
      role="separator"
      tabindex="0"
      aria-label={props.label}
      aria-orientation="vertical"
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      aria-valuenow={props.width()}
      class="shell-resize-handle"
      data-edge={props.edge}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  )
}
