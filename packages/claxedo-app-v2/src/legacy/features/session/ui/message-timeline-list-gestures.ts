import { normalizeWheelDelta, shouldMarkBoundaryGesture } from "./message-gesture"
import type { MessageTimelineProps } from "./message-timeline-props"

/**
 * The scroller a gesture belongs to: `root` unless the event started inside a
 * nested `[data-scrollable]` box, such as a capped tool output.
 */
function boundaryTarget(root: HTMLElement, target: EventTarget | null) {
  const current = target instanceof Element ? target : undefined
  const nested = current?.closest("[data-scrollable]")
  if (!nested || nested === root) return root
  if (!(nested instanceof HTMLElement)) return root
  return nested
}

function markBoundaryGesture(input: {
  root: HTMLDivElement
  target: EventTarget | null
  delta: number
  onMarkScrollGesture: (target?: EventTarget | null) => void
}) {
  const target = boundaryTarget(input.root, input.target)
  if (target === input.root) {
    input.onMarkScrollGesture(input.root)
    return
  }
  if (
    shouldMarkBoundaryGesture({
      delta: input.delta,
      scrollTop: target.scrollTop,
      scrollHeight: target.scrollHeight,
      clientHeight: target.clientHeight,
    })
  ) {
    input.onMarkScrollGesture(input.root)
  }
}

/**
 * The timeline list's wheel, touch, pointer and scroll handlers.
 *
 * `props` is carried rather than spread so every read stays a reactive prop
 * access at the moment the browser dispatches the event.
 */
export function createTimelineListGestures(input: {
  props: MessageTimelineProps
  prepareInteractionScroll: () => void
  prepend: { loading: () => boolean; update: () => void }
  updateViewportMessage: (root: HTMLDivElement) => void
  captureScroll: () => void
}) {
  let touchGesture: number | undefined

  const boundaryGesture = (event: { currentTarget: HTMLDivElement; target: EventTarget | null }, delta: number) =>
    markBoundaryGesture({
      root: event.currentTarget,
      target: event.target,
      delta,
      onMarkScrollGesture: input.props.onMarkScrollGesture,
    })

  const pullAtTop = (event: { currentTarget: HTMLDivElement; target: EventTarget | null }, delta: number) => {
    if (delta >= 0 || event.currentTarget.scrollTop > 0) return
    if (boundaryTarget(event.currentTarget, event.target) !== event.currentTarget) return
    input.props.onHistoryPull?.()
  }

  const onWheel = (event: WheelEvent & { currentTarget: HTMLDivElement }) => {
    input.prepareInteractionScroll()
    const delta = normalizeWheelDelta({
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      rootHeight: event.currentTarget.clientHeight,
    })
    if (!delta) return
    boundaryGesture(event, delta)
    pullAtTop(event, delta)
  }

  const onTouchStart = (event: TouchEvent) => {
    input.prepareInteractionScroll()
    touchGesture = event.touches[0]?.clientY
  }

  const onTouchMove = (event: TouchEvent & { currentTarget: HTMLDivElement }) => {
    const next = event.touches[0]?.clientY
    const prev = touchGesture
    touchGesture = next
    if (next === undefined || prev === undefined) return

    const delta = prev - next
    if (!delta) return

    boundaryGesture(event, delta)
    pullAtTop(event, delta)
  }

  const onTouchEnd = () => {
    touchGesture = undefined
  }

  const onPointerDown = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    // A pointer press on a control is an action, not a scroll gesture. Expanding
    // the cold virtual range here would replace the pressed row between
    // pointerdown and click, so the browser never delivers the click to
    // timeline controls such as WorkGroup and recovery-card buttons.
    const target = event.target instanceof Element ? event.target : undefined
    if (target?.closest("button, a, input, textarea, select, [role='button'], [role='menuitem']")) return
    input.prepareInteractionScroll()
    input.props.onMarkScrollGesture(event.target)
  }

  // Drag-to-select starts on a child node, not the list — mark it so autoscroll yields.
  const onPointerMove = (event: PointerEvent) => {
    if (event.buttons === 1) input.props.onMarkScrollGesture(event.target)
  }

  const onScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    if (!input.props.active()) return
    if (input.prepend.loading()) input.prepend.update()
    input.updateViewportMessage(event.currentTarget)
    input.props.onScheduleScrollState(event.currentTarget)
    input.props.onHistoryScroll()
    // The virtualizer and resizeItem re-anchor own bottom-following.
    if (input.props.hasScrollGesture()) {
      input.props.onUserScroll()
      input.props.onAutoScrollHandleScroll()
      input.props.onMarkScrollGesture(event.currentTarget)
    }
    input.captureScroll()
  }

  return { onWheel, onTouchStart, onTouchMove, onTouchEnd, onPointerDown, onPointerMove, onScroll }
}
