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
    instance.options.horizontal
      ? element.scrollLeft * (instance.options.isRtl ? -1 : 1)
      : element.scrollTop
  const writeOffset = (offset: number) => {
    if (instance.options.horizontal) element.scrollLeft = offset * (instance.options.isRtl ? -1 : 1)
    else element.scrollTop = offset
  }

  let removed = false
  let ancestors = elementAncestors(element, root)
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
    for (const record of records) {
      if (record.target === element || element.contains(record.target)) continue
      if (
        !removed &&
        ancestors.has(record.target) &&
        record.removedNodes.length > 0 &&
        mutationNodesContainElement(record.removedNodes, element)
      ) {
        removed = true
        clearCheck()
      }
      if (
        !removed ||
        !element.isConnected ||
        record.addedNodes.length === 0 ||
        !mutationNodesContainElement(record.addedNodes, element)
      ) continue
      removed = false
      ancestors = elementAncestors(element, root)
      startCheck()
    }
  })
  observer.observe(root, { childList: true, subtree: true })

  return () => {
    active = false
    observer.disconnect()
    clearCheck()
    cleanupOffset?.()
  }
}

function elementAncestors(element: Element, root: Node) {
  const result = new Set<Node>()
  let current: Node | null = element.parentNode
  while (current) {
    result.add(current)
    if (current === root) break
    current = current.parentNode
  }
  return result
}

export function mutationNodesContainElement(nodes: Iterable<Node>, element: Element) {
  return [...nodes].some((node) => node === element || node.contains(element))
}
