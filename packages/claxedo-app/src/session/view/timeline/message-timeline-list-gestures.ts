import { normalizeWheelDelta, shouldMarkBoundaryGesture } from "./message-gesture"
import type { MessageTimelineProps } from "./message-timeline-props"

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
    const target = event.target instanceof Element ? event.target : undefined
    if (target?.closest("button, a, input, textarea, select, [role='button'], [role='menuitem']")) return
    input.prepareInteractionScroll()
    input.props.onMarkScrollGesture(event.target)
  }

  const onPointerMove = (event: PointerEvent) => {
    if (event.buttons === 1) input.props.onMarkScrollGesture(event.target)
  }

  const onScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    if (!input.props.active()) return
    if (input.prepend.loading()) input.prepend.update()
    input.updateViewportMessage(event.currentTarget)
    input.props.onScheduleScrollState(event.currentTarget)
    input.props.onHistoryScroll()
    if (input.props.hasScrollGesture()) {
      input.props.onUserScroll()
      input.props.onAutoScrollHandleScroll()
      input.props.onMarkScrollGesture(event.currentTarget)
    }
    input.captureScroll()
  }

  return { onWheel, onTouchStart, onTouchMove, onTouchEnd, onPointerDown, onPointerMove, onScroll }
}
