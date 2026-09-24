export type ScrollKeyAction = "page-down" | "page-up" | "home" | "end" | "up" | "down"

export const scrollKey = (
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
): ScrollKeyAction | undefined => {
  if (event.altKey || event.ctrlKey || event.metaKey) return undefined
  if (event.shiftKey && event.key !== " ") return undefined
  switch (event.key) {
    case "PageDown":
      return "page-down"
    case "PageUp":
      return "page-up"
    case "Home":
      return "home"
    case "End":
      return "end"
    case "ArrowUp":
      return "up"
    case "ArrowDown":
      return "down"
    case " ":
      return event.shiftKey ? "page-up" : "page-down"
    default:
      return undefined
  }
}

export function canScrollKey(element: HTMLElement, key: ScrollKeyAction) {
  const up = key === "up" || key === "page-up" || key === "home"
  return up ? element.scrollTop > 0 : element.scrollTop + element.clientHeight < element.scrollHeight
}

export function scrollKeyOwner(root: HTMLElement, target: EventTarget | null, key: ScrollKeyAction) {
  const element = target instanceof Element ? target : undefined
  const owner = element?.closest<HTMLElement>("[data-scrollable]")
  if (!owner || owner === root) return root
  if (!root.contains(owner)) return owner
  return canScrollKey(owner, key) ? owner : root
}

export function isScrollKeyTarget(target: EventTarget | null, key: ScrollKeyAction) {
  const element = target instanceof HTMLElement ? target : undefined
  if (!element) return true
  if (["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) || element.isContentEditable) return false
  if ((key === "page-up" || key === "page-down") && element.closest('button, a[href], [role="button"]')) return false
  return true
}

export function scrollByKey(viewport: HTMLElement, key: ScrollKeyAction) {
  const page = viewport.clientHeight * 0.8
  const line = 40
  switch (key) {
    case "page-down":
      return viewport.scrollBy({ top: page, behavior: "smooth" })
    case "page-up":
      return viewport.scrollBy({ top: -page, behavior: "smooth" })
    case "home":
      return viewport.scrollTo({ top: 0, behavior: "instant" })
    case "end":
      return viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" })
    case "up":
      return viewport.scrollBy({ top: -line, behavior: "smooth" })
    case "down":
      return viewport.scrollBy({ top: line, behavior: "smooth" })
  }
}

export function scrollTopFromThumbPointer(input: {
  pointer: number
  viewportTop: number
  grabOffset: number
  clientHeight: number
  scrollHeight: number
  thumbHeight: number
  scrollClientHeight?: number
}) {
  const padding = 8
  const maxThumbTop = input.clientHeight - padding * 2 - input.thumbHeight
  if (maxThumbTop <= 0) return 0
  const thumbTop = Math.max(0, Math.min(input.pointer - input.viewportTop - padding - input.grabOffset, maxThumbTop))
  return (thumbTop / maxThumbTop) * Math.max(0, input.scrollHeight - (input.scrollClientHeight ?? input.clientHeight))
}
