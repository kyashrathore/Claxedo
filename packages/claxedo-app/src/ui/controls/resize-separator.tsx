import { onCleanup, type JSX } from "solid-js"

export type ResizeGrowth = "left" | "right"

type Drag = {
  readonly grows: ResizeGrowth
  readonly pointerId: number
  readonly startX: number
  readonly startWidth: number
  readonly handle: HTMLElement
}

function growthSign(grows: ResizeGrowth): number {
  return grows === "right" ? 1 : -1
}

type Range = { readonly value: number; readonly min: number; readonly max: number; readonly grows: ResizeGrowth }

function keyboardWidth(key: string, range: Range): number | undefined {
  if (key === "ArrowRight") return range.value + growthSign(range.grows) * 24
  if (key === "ArrowLeft") return range.value - growthSign(range.grows) * 24
  if (key === "Home") return range.min
  if (key === "End") return range.max
  return undefined
}

function suspendPage(): () => void {
  const previousUserSelect = document.body.style.userSelect
  const previousCursor = document.body.style.cursor
  document.body.style.userSelect = "none"
  document.body.style.cursor = "col-resize"
  return () => {
    document.body.style.userSelect = previousUserSelect
    document.body.style.cursor = previousCursor
  }
}

function trackDrag(drag: Drag, onWidth: (width: number) => void, onEnd: () => void): () => void {
  let frame: number | undefined
  let latestX = drag.startX
  const restorePage = suspendPage()
  const flush = () => {
    frame = undefined
    onWidth(drag.startWidth + growthSign(drag.grows) * (latestX - drag.startX))
  }
  const onMove = (event: PointerEvent) => {
    if (event.pointerId !== drag.pointerId) return
    latestX = event.clientX
    frame ??= requestAnimationFrame(flush)
  }
  const finish = finishDrag(drag, () => frame, onEnd, restorePage, onUp, onCancel, onMove)
  function onUp(event: PointerEvent) {
    if (event.pointerId !== drag.pointerId) return
    latestX = event.clientX
    flush()
    finish()
  }
  function onCancel(event: PointerEvent) {
    if (event.pointerId === drag.pointerId) finish()
  }
  window.addEventListener("pointermove", onMove)
  window.addEventListener("pointerup", onUp)
  window.addEventListener("pointercancel", onCancel)
  return finish
}

function finishDrag(
  drag: Drag,
  frame: () => number | undefined,
  onEnd: () => void,
  restorePage: () => void,
  onUp: (event: PointerEvent) => void,
  onCancel: (event: PointerEvent) => void,
  onMove: (event: PointerEvent) => void,
): () => void {
  return () => {
    const pendingFrame = frame()
    if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame)
    restorePage()
    window.removeEventListener("pointermove", onMove)
    window.removeEventListener("pointerup", onUp)
    window.removeEventListener("pointercancel", onCancel)
    if (drag.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId)
    onEnd()
  }
}

export type ResizeSeparatorProps = Range & {
  readonly label: string
  readonly class: string
  readonly onResize: (width: number) => void
  readonly onDragging: (dragging: boolean) => void
}

export function ResizeSeparator(props: ResizeSeparatorProps): JSX.Element {
  let stop: (() => void) | undefined
  onCleanup(() => stop?.())
  const start = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    stop?.()
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    props.onDragging(true)
    const drag = {
      grows: props.grows,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: props.value,
      handle: event.currentTarget,
    }
    stop = trackDrag(drag, props.onResize, () => {
      stop = undefined
      props.onDragging(false)
    })
  }
  const resizeByKeyboard = (event: KeyboardEvent) => {
    const next = keyboardWidth(event.key, props)
    if (next === undefined) return
    event.preventDefault()
    event.stopPropagation()
    props.onResize(next)
  }
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuenow={Math.round(props.value)}
      aria-valuemin={props.min}
      aria-valuemax={Math.round(props.max)}
      class={`absolute bottom-0 top-0 z-10 cursor-col-resize outline-none transition-colors ${props.class}`}
      onPointerDown={start}
      onKeyDown={resizeByKeyboard}
    />
  )
}
