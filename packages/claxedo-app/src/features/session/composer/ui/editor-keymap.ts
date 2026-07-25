import { getCursorPosition } from "@/features/session/composer/ui/editor-dom"
import { canNavigateHistoryAtCursor } from "@/features/session/composer/ui/history"

type PromptInputMode = "normal" | "shell"
type PromptInputPopover = "at" | "slash" | null

type CaretState = {
  collapsed: boolean
  cursorPosition: number
  textLength: number
}

export type PromptInputKeyEvent = Pick<
  KeyboardEvent,
  | "altKey"
  | "code"
  | "ctrlKey"
  | "isComposing"
  | "key"
  | "keyCode"
  | "metaKey"
  | "repeat"
  | "shiftKey"
  | "preventDefault"
  | "stopPropagation"
>

type PromptInputKeymapDeps<TEvent extends PromptInputKeyEvent> = {
  editor: () => HTMLElement
  mode: () => PromptInputMode
  setMode: (mode: PromptInputMode) => void
  popover: () => PromptInputPopover
  closePopover: () => void
  pick: () => void
  getCaretState: () => CaretState
  isImeComposing: (event: TEvent) => boolean
  addTextPart: (content: string) => void
  selectPopoverActive: () => void
  atOnKeyDown: (event: TEvent) => void
  slashOnKeyDown: (event: TEvent) => void
  stoppable: () => boolean
  abort: () => void
  escBlur: () => boolean
  booting: () => boolean
  working: () => boolean
  blank: () => boolean
  promptText: () => string
  historyActive: () => boolean
  navigateHistory: (direction: "up" | "down") => boolean
  handleSubmit: (event: TEvent) => unknown
}

export function createPromptInputKeyDown<TEvent extends PromptInputKeyEvent>(deps: PromptInputKeymapDeps<TEvent>) {
  return (event: TEvent) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "u") {
      event.preventDefault()
      if (deps.mode() !== "normal") return
      deps.pick()
      return
    }

    if (event.key === "Backspace") {
      moveBeforeZeroWidthSentinel()
    }

    if (event.key === "!" && deps.mode() === "normal") {
      const cursorPosition = getCursorPosition(deps.editor())
      if (cursorPosition === 0) {
        deps.setMode("shell")
        event.preventDefault()
        return
      }
    }

    if (event.key === "Escape") {
      if (deps.popover()) {
        deps.closePopover()
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (deps.mode() === "shell") {
        deps.setMode("normal")
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (deps.stoppable()) {
        deps.abort()
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (deps.escBlur()) {
        deps.editor().blur()
        event.preventDefault()
        event.stopPropagation()
        return
      }
    }

    if (deps.mode() === "shell") {
      const { collapsed, cursorPosition, textLength } = deps.getCaretState()
      if (event.key === "Backspace" && collapsed && cursorPosition === 0 && textLength === 0) {
        deps.setMode("normal")
        event.preventDefault()
        return
      }
    }

    if (event.key === "Enter" && event.shiftKey) {
      deps.addTextPart("\n")
      event.preventDefault()
      return
    }

    if (event.key === "Enter" && deps.isImeComposing(event)) {
      return
    }

    const ctrl = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey

    if (deps.popover()) {
      if (event.key === "Tab") {
        deps.selectPopoverActive()
        event.preventDefault()
        return
      }
      const nav = event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter"
      const ctrlNav = ctrl && (event.key === "n" || event.key === "p")
      if (nav || ctrlNav) {
        if (deps.popover() === "at") {
          deps.atOnKeyDown(event)
          event.preventDefault()
          return
        }
        if (deps.popover() === "slash") {
          deps.slashOnKeyDown(event)
        }
        event.preventDefault()
        return
      }
    }

    if (ctrl && event.code === "KeyG") {
      if (deps.popover()) {
        deps.closePopover()
        event.preventDefault()
        return
      }
      if (deps.stoppable()) {
        deps.abort()
        event.preventDefault()
      }
      return
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const { collapsed } = deps.getCaretState()
      if (!collapsed) return

      const cursorPosition = getCursorPosition(deps.editor())
      const direction = event.key === "ArrowUp" ? "up" : "down"
      if (!canNavigateHistoryAtCursor(direction, deps.promptText(), cursorPosition, deps.historyActive())) return
      if (deps.navigateHistory(direction)) {
        event.preventDefault()
      }
      return
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      if (event.repeat) return
      if (deps.booting()) return
      if (deps.working() && deps.blank()) return
      void deps.handleSubmit(event)
    }
  }
}

/**
 * Backspace next to the zero-width sentinel we append after a trailing `<br>`
 * would delete the sentinel instead of the newline. Exported because the
 * controller engine needs the same pre-step (plan 2026-07-25-005 T2.2): upstream's
 * `interaction.ts` has no notion of our sentinel.
 */
export function moveBeforeZeroWidthSentinel() {
  const selection = window.getSelection()
  if (!selection?.isCollapsed) return

  const node = selection.anchorNode
  const offset = selection.anchorOffset
  if (!node || node.nodeType !== Node.TEXT_NODE) return

  const text = node.textContent ?? ""
  if (!/^\u200B+$/.test(text) || offset <= 0) return

  const range = document.createRange()
  range.setStart(node, 0)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}
