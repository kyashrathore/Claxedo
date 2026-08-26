import { isEditableTagName } from "./session-keydown"

export function isEditableTarget(target: EventTarget | null | undefined) {
  return target instanceof HTMLElement && (isEditableTagName(target.tagName) || target.isContentEditable)
}

export function deepActiveElement() {
  let current: Element | null = document.activeElement
  while (current instanceof HTMLElement && current.shadowRoot?.activeElement) {
    current = current.shadowRoot.activeElement
  }
  return current instanceof HTMLElement ? current : undefined
}
