import { onCleanup, type JSX } from "solid-js"
import { emitTerminalFit } from "@/lib/terminal-fit"
import { usePanel } from "../store"
import { maxPanelWidth, PANEL_MIN_WIDTH, PANEL_RESIZE_KEY_STEP } from "../width"

type Drag = {
  readonly pointerId: number
  readonly startX: number
  readonly startWidth: number
  readonly handle: HTMLElement
}

function keyboardWidth(key: string, current: number, max: number): number | undefined {
  if (key === "ArrowLeft") return current + PANEL_RESIZE_KEY_STEP
  if (key === "ArrowRight") return current - PANEL_RESIZE_KEY_STEP
  if (key === "Home") return PANEL_MIN_WIDTH
  if (key === "End") return max
  return undefined
}

function suspendPage(): () => void {
  const previousUserSelect = document.body.style.userSelect
  const previousCursor = document.body.style.cursor
  const previousSuspended = document.documentElement.dataset.terminalResizeSuspended
  document.body.style.userSelect = "none"
  document.body.style.cursor = "col-resize"
  document.documentElement.dataset.terminalResizeSuspended = "1"
  return () => {
    document.body.style.userSelect = previousUserSelect
    document.body.style.cursor = previousCursor
    if (previousSuspended === undefined) delete document.documentElement.dataset.terminalResizeSuspended
    else document.documentElement.dataset.terminalResizeSuspended = previousSuspended
  }
}

function trackDrag(drag: Drag, onWidth: (width: number) => void, onEnd: () => void): () => void {
  let frame: number | undefined
  let latestX = drag.startX
  const restorePage = suspendPage()
  const flush = () => {
    frame = undefined
    onWidth(drag.startWidth + drag.startX - latestX)
  }
  const onMove = (event: PointerEvent) => {
    if (event.pointerId !== drag.pointerId) return
    latestX = event.clientX
    frame ??= requestAnimationFrame(flush)
  }
  const finish = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    restorePage()
    window.removeEventListener("pointermove", onMove)
    window.removeEventListener("pointerup", onUp)
    window.removeEventListener("pointercancel", onCancel)
    if (drag.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId)
    onEnd()
    emitTerminalFit()
  }
  const onUp = (event: PointerEvent) => {
    if (event.pointerId !== drag.pointerId) return
    latestX = event.clientX
    flush()
    finish()
  }
  const onCancel = (event: PointerEvent) => {
    if (event.pointerId === drag.pointerId) finish()
  }
  window.addEventListener("pointermove", onMove)
  window.addEventListener("pointerup", onUp)
  window.addEventListener("pointercancel", onCancel)
  return finish
}

export function PanelResizeHandle(props: { readonly onDragging: (dragging: boolean) => void }): JSX.Element {
  const panel = usePanel()
  let stop: (() => void) | undefined
  onCleanup(() => stop?.())
  const start = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    stop?.()
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    props.onDragging(true)
    const drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: panel.width(),
      handle: event.currentTarget,
    }
    stop = trackDrag(drag, panel.chooseWidth, () => {
      stop = undefined
      props.onDragging(false)
    })
  }
  const resizeByKeyboard = (event: KeyboardEvent) => {
    const next = keyboardWidth(event.key, panel.width(), maxPanelWidth(panel.available()))
    if (next === undefined) return
    event.preventDefault()
    panel.chooseWidth(next)
    emitTerminalFit()
  }
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize workspace panel"
      aria-valuenow={Math.round(panel.width())}
      aria-valuemin={PANEL_MIN_WIDTH}
      aria-valuemax={Math.round(maxPanelWidth(panel.available()))}
      class="absolute bottom-0 left-0 top-0 z-10 w-1 cursor-col-resize outline-none transition-colors hover:bg-border-weak-base/25 focus-visible:bg-border-interactive-base/60 active:bg-border-weak-base/45"
      onPointerDown={start}
      onKeyDown={resizeByKeyboard}
    />
  )
}
