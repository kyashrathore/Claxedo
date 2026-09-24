import type { DragController, DragSourceKind } from "./pointer-drag"

const MOUSE_THRESHOLD_PX = 5
const TOUCH_THRESHOLD_PX = 8
const TOUCH_LONG_PRESS_MS = 250

export type DragSourceOptions = {
  contentId: () => string | undefined
  sourceKind: DragSourceKind
  label?: () => string | undefined
  enabled?: () => boolean
  touchAction?: string
  onBegin?: (event: PointerEvent) => void
  onEnd?: () => void
  onDropMissed?: () => void
}

type Session = {
  pointerId: number
  startX: number
  startY: number
  dragging: boolean
  longPress: ReturnType<typeof setTimeout> | null
}

export function useDragSource(drag: DragController, el: HTMLElement, options: DragSourceOptions): () => void {
  el.style.touchAction = options.touchAction ?? "pan-y"
  let session: Session | null = null

  const teardown = () => {
    if (!session) return
    const ended = session
    session = null
    if (ended.longPress != null) clearTimeout(ended.longPress)
    if (el.hasPointerCapture(ended.pointerId)) el.releasePointerCapture(ended.pointerId)
    window.removeEventListener("pointermove", onMove)
    window.removeEventListener("pointerup", onUp)
    window.removeEventListener("pointercancel", onCancel)
    if (ended.dragging) options.onEnd?.()
  }

  const beginDrag = (event: PointerEvent, x: number, y: number) => {
    if (!session) return
    const contentId = options.contentId()
    if (!contentId) {
      teardown()
      return
    }
    session.dragging = true
    if (session.longPress != null) clearTimeout(session.longPress)
    session.longPress = null
    el.setPointerCapture(session.pointerId)
    drag.begin({ contentId, sourceKind: options.sourceKind, x, y, label: options.label?.() })
    options.onBegin?.(event)
  }

  const onMove = (event: PointerEvent) => {
    if (!session || event.pointerId !== session.pointerId) return
    if (session.dragging) {
      event.preventDefault()
      drag.move(event.clientX, event.clientY)
      return
    }
    const isTouch = event.pointerType === "touch"
    const threshold = isTouch ? TOUCH_THRESHOLD_PX : MOUSE_THRESHOLD_PX
    if (Math.hypot(event.clientX - session.startX, event.clientY - session.startY) < threshold) return
    if (isTouch) teardown()
    else beginDrag(event, event.clientX, event.clientY)
  }

  const onUp = (event: PointerEvent) => {
    if (!session || event.pointerId !== session.pointerId) return
    const recoverable = session.dragging && drag.active()
    const consumed = session.dragging ? drag.end() : false
    teardown()
    if (recoverable && !consumed) options.onDropMissed?.()
  }

  const onCancel = (event: PointerEvent) => {
    if (!session || event.pointerId !== session.pointerId) return
    if (session.dragging) drag.cancel()
    teardown()
  }

  const onDown = (event: PointerEvent) => {
    if (options.enabled && !options.enabled()) return
    if (event.button > 0) return
    session = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false, longPress: null }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onCancel)
    if (event.pointerType !== "touch") return
    session.longPress = setTimeout(() => {
      if (session && !session.dragging) beginDrag(event, session.startX, session.startY)
    }, TOUCH_LONG_PRESS_MS)
  }

  el.addEventListener("pointerdown", onDown)
  return () => {
    el.removeEventListener("pointerdown", onDown)
    teardown()
  }
}
