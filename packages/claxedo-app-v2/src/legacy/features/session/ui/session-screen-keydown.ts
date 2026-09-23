// The session screen's document-level keydown routing: ignores editable and
// autofocus-protected targets (including inside shadow roots), lets Escape blur
// the composer, forwards explicit scroll keys as scroll gestures, and focuses
// the composer with caret restoration for typing keys. Key classification
// itself lives in session-keydown.ts; this wires it to the live screen.
import { setCursorPosition } from "@/features/session/composer/ui/editor-dom"
import { promptLength } from "@/features/session/composer/ui/history"
import { classifySessionKeydown, isEditableTagName } from "@/features/session/ui/session-keydown"
import type { usePrompt } from "@/features/session/providers/prompt"

export function createSessionScreenKeydownHandler(input: {
  active: () => boolean
  // Truthiness check, matching the original inline `if (dialog.active) return`.
  dialogActive: () => unknown
  inputEl: () => HTMLDivElement | undefined
  composerBlocked: () => boolean
  prompt: Pick<ReturnType<typeof usePrompt>, "cursor" | "current">
  markScrollGesture: () => void
}) {
  const isEditableTarget = (target: EventTarget | null | undefined) => {
    if (!(target instanceof HTMLElement)) return false
    return isEditableTagName(target.tagName) || target.isContentEditable
  }

  const deepActiveElement = () => {
    let current: Element | null = document.activeElement
    while (current instanceof HTMLElement && current.shadowRoot?.activeElement) {
      current = current.shadowRoot.activeElement
    }
    return current instanceof HTMLElement ? current : undefined
  }

  return (event: KeyboardEvent) => {
    if (!input.active()) return
    const path = event.composedPath()
    const target = path.find((item): item is HTMLElement => item instanceof HTMLElement)
    const activeElement = deepActiveElement()

    const protectedTarget = path.some(
      (item) => item instanceof HTMLElement && item.closest("[data-prevent-autofocus]") !== null,
    )
    if (protectedTarget || isEditableTarget(target)) return

    if (activeElement) {
      const isProtected = activeElement.closest("[data-prevent-autofocus]")
      const isInput = isEditableTarget(activeElement)
      if (isProtected || isInput) return
    }
    if (input.dialogActive()) return

    if (activeElement === input.inputEl()) {
      if (event.key === "Escape") input.inputEl()?.blur()
      return
    }

    // Only treat explicit scroll keys as potential "user scroll" gestures.
    const action = classifySessionKeydown(event)
    if (action === "scroll-gesture") {
      input.markScrollGesture()
      return
    }

    if (action === "focus-input") {
      if (input.composerBlocked()) return
      const el = input.inputEl()
      if (!el) return
      el.focus()
      // Blur may have destroyed the DOM selection (editor re-renders) — restore
      // the caret the composer persisted into the prompt store.
      setCursorPosition(el, input.prompt.cursor() ?? promptLength(input.prompt.current()))
    }
  }
}
