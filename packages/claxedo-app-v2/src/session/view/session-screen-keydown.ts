import { onCleanup } from "solid-js"
import { setCursorPosition } from "@/composer"
import { classifySessionKeydown, deepActiveElement, keydownBelongsElsewhere } from "./session-keydown"

type KeydownInput = {
  active: () => boolean
  dialogActive: () => unknown
  inputEl: () => HTMLDivElement | undefined
  composerBlocked: () => boolean
  prompt: { readonly cursor: () => number | undefined; readonly length: () => number }
  markScrollGesture: () => void
}

export function installSessionScreenKeydown(input: KeydownInput): void {
  const handleKeyDown = sessionScreenKeydownHandler(input)
  document.addEventListener("keydown", handleKeyDown)
  onCleanup(() => document.removeEventListener("keydown", handleKeyDown))
}

function sessionScreenKeydownHandler(input: KeydownInput) {
  return (event: KeyboardEvent) => {
    if (!input.active()) return
    const activeElement = deepActiveElement()
    if (keydownBelongsElsewhere(event, activeElement) || input.dialogActive()) return
    const el = input.inputEl()
    if (activeElement === el) {
      if (event.key === "Escape") el?.blur()
      return
    }
    const action = classifySessionKeydown(event)
    if (action === "scroll-gesture") return input.markScrollGesture()
    if (action !== "focus-input" || input.composerBlocked() || !el) return
    el.focus()
    setCursorPosition(el, input.prompt.cursor() ?? input.prompt.length())
  }
}
