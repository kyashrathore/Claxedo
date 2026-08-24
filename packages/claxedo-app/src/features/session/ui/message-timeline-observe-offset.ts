import { observeElementOffset, observeElementRect, type Virtualizer } from "@tanstack/virtual-core"
import { markRendererPhase } from "@/platform/performance/renderer-trace"

export const observeElementRectDeduped: typeof observeElementRect = (instance, callback) => {
  return observeElementRect(instance, createObservedRectHandler(instance, callback))
}

export function createObservedRectHandler<T extends { width: number; height: number }>(
  instance: { scrollRect: T | null },
  callback: (rect: T) => void,
) {
  let width: number | undefined
  let height: number | undefined
  let initialObservation = true
  return (rect: T) => {
    if (rect.width === width && rect.height === height) return
    width = rect.width
    height = rect.height
    const currentRect = instance.scrollRect
    if (initialObservation && currentRect && currentRect.width > 0 && currentRect.height > 0) {
      initialObservation = false
      instance.scrollRect = rect
      return
    }
    initialObservation = false
    callback(rect)
  }
}

// Ported from upstream packages/app/src/pages/session/timeline/observe-element-offset.ts (#36643),
// with restore-first reconnect semantics.
// When the timeline's scroll element is detached and re-inserted under a
// persistent host (a workbench slot move, a suspense re-attach), the browser
// resets its native scroll position while the virtualizer's `scrollOffset`
// still holds the authoritative place. The stock offset observer never
// re-fires for the restored element, so the two disagree forever. This wrapper
// watches for the element's removal/reinsertion and reconciles: it writes the
// virtualizer's stored offset back to the element — delivering the reset
// native offset instead would re-render the range at the top and then
// re-anchor to the bottom, two full row-set rebuilds inside one long
// main-thread task. Only when the write does not stick (the restored element
// genuinely cannot reach the stored offset) is the native offset delivered so
// the virtualizer re-derives its range from reality.
export function observeElementOffsetReconnectAware<TScrollElement extends Element, TItemElement extends Element>(
  instance: Virtualizer<TScrollElement, TItemElement>,
  callback: (offset: number, isScrolling: boolean) => void,
) {
  let active = true
  const deliver = (offset: number, isScrolling: boolean) => {
    if (!active) return
    callback(offset, isScrolling)
  }
  const cleanupOffset = observeElementOffset(instance, deliver)
  const element = instance.scrollElement
  const targetWindow = instance.targetWindow
  const root = element?.closest("main") ?? element?.ownerDocument.body
  if (!element || !targetWindow || !root)
    return () => {
      active = false
      cleanupOffset?.()
    }

  const readOffset = () =>
    instance.options.horizontal ? element.scrollLeft * (instance.options.isRtl ? -1 : 1) : element.scrollTop
  const writeOffset = (offset: number) => {
    if (instance.options.horizontal) element.scrollLeft = offset * (instance.options.isRtl ? -1 : 1)
    else element.scrollTop = offset
  }

  let removed = false
  let frame: number | undefined
  const clearCheck = () => {
    if (frame === undefined) return
    targetWindow.cancelAnimationFrame(frame)
    frame = undefined
  }
  const startCheck = () => {
    markRendererPhase("timeline.offsetReconnect.startCheck")
    clearCheck()
    const deadline = targetWindow.performance.now() + instance.options.isScrollingResetDelay
    let framesAfterDeadline = 0
    const check = (time: number) => {
      frame = undefined
      if (element.isConnected) {
        const offset = readOffset()
        const stored = instance.scrollOffset
        if (stored === null) {
          deliver(offset, false)
        } else if (Math.abs(offset - stored) > 1) {
          writeOffset(stored)
          const restored = readOffset()
          if (Math.abs(restored - stored) > 1) deliver(restored, false)
        }
      }
      if (time >= deadline) framesAfterDeadline += 1
      if (framesAfterDeadline >= 2) return
      frame = targetWindow.requestAnimationFrame(check)
    }
    frame = targetWindow.requestAnimationFrame(check)
  }
  const observer = new targetWindow.MutationObserver((records) => {
    if (!active) return
    records.forEach((record) => {
      if (record.target === element || element.contains(record.target)) return
      if (mutationNodesContainElement(record.removedNodes, element)) {
        removed = true
        clearCheck()
      }
      if (!removed || !element.isConnected || !mutationNodesContainElement(record.addedNodes, element)) return
      removed = false
      startCheck()
    })
  })
  // Session routes are replaced below persistent main; body is the fallback for isolated hosts.
  observer.observe(root, { childList: true, subtree: true })

  return () => {
    active = false
    observer.disconnect()
    clearCheck()
    cleanupOffset?.()
  }
}

export function mutationNodesContainElement(nodes: Iterable<Node>, element: Element) {
  return [...nodes].some((node) => node === element || node.contains(element))
}
