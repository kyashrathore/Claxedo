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

type Gesture = {
  readonly drag: DragController
  readonly el: HTMLElement
  readonly options: DragSourceOptions
  session: Session | null
  readonly listeners: { readonly move: (event: PointerEvent) => void; readonly up: (event: PointerEvent) => void; readonly cancel: (event: PointerEvent) => void }
}

function teardown(gesture: Gesture): void {
  const ended = gesture.session
  if (!ended) return
  gesture.session = null
  if (ended.longPress != null) clearTimeout(ended.longPress)
  if (gesture.el.hasPointerCapture(ended.pointerId)) gesture.el.releasePointerCapture(ended.pointerId)
  window.removeEventListener("pointermove", gesture.listeners.move)
  window.removeEventListener("pointerup", gesture.listeners.up)
  window.removeEventListener("pointercancel", gesture.listeners.cancel)
  if (ended.dragging) gesture.options.onEnd?.()
}

function beginDrag(gesture: Gesture, event: PointerEvent, x: number, y: number): void {
  const session = gesture.session
  if (!session) return
  const contentId = gesture.options.contentId()
  if (!contentId) return teardown(gesture)
  session.dragging = true
  if (session.longPress != null) clearTimeout(session.longPress)
  session.longPress = null
  gesture.el.setPointerCapture(session.pointerId)
  gesture.drag.begin({ contentId, sourceKind: gesture.options.sourceKind, x, y, label: gesture.options.label?.() })
  gesture.options.onBegin?.(event)
}

function pointerMove(gesture: Gesture, event: PointerEvent): void {
  const session = gesture.session
  if (!session || event.pointerId !== session.pointerId) return
  if (session.dragging) {
    event.preventDefault()
    gesture.drag.move(event.clientX, event.clientY)
    return
  }
  const isTouch = event.pointerType === "touch"
  const threshold = isTouch ? TOUCH_THRESHOLD_PX : MOUSE_THRESHOLD_PX
  if (Math.hypot(event.clientX - session.startX, event.clientY - session.startY) < threshold) return
  if (isTouch) teardown(gesture)
  else beginDrag(gesture, event, event.clientX, event.clientY)
}

function pointerUp(gesture: Gesture, event: PointerEvent): void {
  const session = gesture.session
  if (!session || event.pointerId !== session.pointerId) return
  const recoverable = session.dragging && gesture.drag.active()
  const consumed = session.dragging ? gesture.drag.end() : false
  teardown(gesture)
  if (recoverable && !consumed) gesture.options.onDropMissed?.()
}

function pointerCancel(gesture: Gesture, event: PointerEvent): void {
  const session = gesture.session
  if (!session || event.pointerId !== session.pointerId) return
  if (session.dragging) gesture.drag.cancel()
  teardown(gesture)
}

function pointerDown(gesture: Gesture, event: PointerEvent): void {
  if (gesture.options.enabled && !gesture.options.enabled()) return
  if (event.button > 0) return
  const session: Session = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false, longPress: null }
  gesture.session = session
  window.addEventListener("pointermove", gesture.listeners.move)
  window.addEventListener("pointerup", gesture.listeners.up)
  window.addEventListener("pointercancel", gesture.listeners.cancel)
  if (event.pointerType !== "touch") return
  session.longPress = setTimeout(() => {
    if (gesture.session === session && !session.dragging) beginDrag(gesture, event, session.startX, session.startY)
  }, TOUCH_LONG_PRESS_MS)
}

export function useDragSource(drag: DragController, el: HTMLElement, options: DragSourceOptions): () => void {
  el.style.touchAction = options.touchAction ?? "pan-y"
  const gesture: Gesture = {
    drag,
    el,
    options,
    session: null,
    listeners: {
      move: (event) => pointerMove(gesture, event),
      up: (event) => pointerUp(gesture, event),
      cancel: (event) => pointerCancel(gesture, event),
    },
  }
  const onDown = (event: PointerEvent) => pointerDown(gesture, event)
  el.addEventListener("pointerdown", onDown)
  return () => {
    el.removeEventListener("pointerdown", onDown)
    teardown(gesture)
  }
}
