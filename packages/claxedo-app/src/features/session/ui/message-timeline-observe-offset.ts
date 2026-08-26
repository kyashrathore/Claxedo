import { createEffect, on } from "solid-js"
import { observeElementOffset, observeElementRect, type Virtualizer } from "@tanstack/solid-virtual"

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

/**
 * Presentation state of the surface that owns a timeline. Workbench keeps the
 * outgoing session mounted but stashed, so the reconnect repair below has to
 * know whether anything is presented before it starts reading layout.
 */
export type ReconnectRepairPresentation = {
  presented: () => boolean
  /** Notifies on a presentation transition; returns an unsubscribe. */
  subscribe: (listener: () => void) => () => void
}

export function createReconnectAwareOffsetObserver(
  presentation: ReconnectRepairPresentation,
): typeof observeElementOffset {
  return (instance, callback) => observeElementOffsetReconnectAware(instance, callback, presentation)
}

/** Adapts a surface's reactive visibility to the presentation port above. */
export function createSurfacePresentation(active: () => boolean): ReconnectRepairPresentation {
  const listeners = new Set<() => void>()
  createEffect(
    on(
      active,
      () => {
        for (const listener of [...listeners]) listener()
      },
      { defer: true },
    ),
  )
  return {
    presented: active,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

// Ported from upstream packages/app/src/pages/session/timeline/observe-element-offset.ts (#36643).
// When a route reconnect swaps the timeline's scroll element under a persistent
// host, the virtualizer's stock offset observer never re-fires for the restored
// element, leaving scrollOffset stale. This wrapper watches for the element's
// removal/reinsertion and re-delivers the divergent offset until any queued
// scroll-end reset can no longer win.
function observeElementOffsetReconnectAware<TScrollElement extends Element, TItemElement extends Element>(
  instance: Virtualizer<TScrollElement, TItemElement>,
  callback: (offset: number, isScrolling: boolean) => void,
  presentation: ReconnectRepairPresentation,
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

  let removed = false
  let repairPending = false
  let frame: number | undefined
  const clearCheck = () => {
    if (frame === undefined) return
    targetWindow.cancelAnimationFrame(frame)
    frame = undefined
  }
  const startCheck = () => {
    clearCheck()
    const deadline = targetWindow.performance.now() + instance.options.isScrollingResetDelay
    let framesAfterDeadline = 0
    const check = (time: number) => {
      frame = undefined
      if (element.isConnected) {
        const offset = instance.options.horizontal
          ? element.scrollLeft * (instance.options.isRtl ? -1 : 1)
          : element.scrollTop
        if (instance.scrollOffset === null || Math.abs(offset - instance.scrollOffset) > 1) deliver(offset, false)
      }
      if (time >= deadline) framesAfterDeadline += 1
      if (framesAfterDeadline >= 2) return
      frame = targetWindow.requestAnimationFrame(check)
    }
    frame = targetWindow.requestAnimationFrame(check)
  }
  // A stashed surface presents no offset, so polling it would only force a
  // document style recalculation inside whatever interaction reinserted it.
  // Hold the repair instead and run the same check once it is presented again.
  const requestRepair = () => {
    if (!presentation.presented()) {
      repairPending = true
      return
    }
    repairPending = false
    startCheck()
  }
  const unsubscribePresented = presentation.subscribe(() => {
    if (!active || !repairPending || !presentation.presented()) return
    repairPending = false
    startCheck()
  })

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
      requestRepair()
    })
  })
  // Session routes are replaced below persistent main; body is the fallback for isolated hosts.
  observer.observe(root, { childList: true, subtree: true })

  return () => {
    active = false
    repairPending = false
    unsubscribePresented()
    observer.disconnect()
    clearCheck()
    cleanupOffset?.()
  }
}

export function mutationNodesContainElement(nodes: Iterable<Node>, element: Element) {
  return [...nodes].some((node) => node === element || node.contains(element))
}
