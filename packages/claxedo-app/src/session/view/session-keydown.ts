export type SessionKeyAction = "scroll-gesture" | "focus-input" | "ignore"

function isEditableTarget(target: EventTarget | null | undefined): boolean {
  if (!(target instanceof HTMLElement)) return false
  return /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName) || target.isContentEditable
}

export function deepActiveElement(): HTMLElement | undefined {
  let current: Element | null = document.activeElement
  while (current instanceof HTMLElement && current.shadowRoot?.activeElement) {
    current = current.shadowRoot.activeElement
  }
  return current instanceof HTMLElement ? current : undefined
}

export function keydownBelongsElsewhere(event: KeyboardEvent, activeElement: HTMLElement | undefined): boolean {
  const path = event.composedPath()
  const target = path.find((item): item is HTMLElement => item instanceof HTMLElement)
  const protectedTarget = path.some((item) => item instanceof HTMLElement && item.closest("[data-prevent-autofocus]") !== null)
  if (protectedTarget || isEditableTarget(target)) return true
  if (!activeElement) return false
  return activeElement.closest("[data-prevent-autofocus]") !== null || isEditableTarget(activeElement)
}

export function classifySessionKeydown(event: { key: string; ctrlKey?: boolean; metaKey?: boolean }): SessionKeyAction {
  const { key } = event
  if (key === "PageUp" || key === "PageDown" || key === "Home" || key === "End") return "scroll-gesture"
  if (key.length === 1 && key !== "Unidentified" && !(event.ctrlKey || event.metaKey)) return "focus-input"
  return "ignore"
}
