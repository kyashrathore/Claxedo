import type { EditorMode } from "../model"
import { getCursorPosition } from "./dom"
import { canNavigateHistoryAtCursor } from "./history"

export type PopoverKind = "at" | "slash" | null

type CaretState = {
  collapsed: boolean
  cursorPosition: number
  textLength: number
}

export type EditorKeyEvent = Pick<
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

export type EditorKeymapDeps<TEvent extends EditorKeyEvent> = {
  editor: () => HTMLElement
  mode: () => EditorMode
  setMode: (mode: EditorMode) => void
  popover: () => PopoverKind
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

function handleEscape<TEvent extends EditorKeyEvent>(deps: EditorKeymapDeps<TEvent>) {
  if (deps.popover()) {
    deps.closePopover()
    return true
  }
  if (deps.mode() === "shell") {
    deps.setMode("normal")
    return true
  }
  if (deps.stoppable()) {
    deps.abort()
    return true
  }
  if (deps.escBlur()) {
    deps.editor().blur()
    return true
  }
  return false
}

function handlePopoverKey<TEvent extends EditorKeyEvent>(deps: EditorKeymapDeps<TEvent>, event: TEvent, ctrl: boolean) {
  if (event.key === "Tab") {
    deps.selectPopoverActive()
    return true
  }
  const nav = event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter"
  const ctrlNav = ctrl && (event.key === "n" || event.key === "p")
  if (!nav && !ctrlNav) return false
  if (deps.popover() === "at") deps.atOnKeyDown(event)
  if (deps.popover() === "slash") deps.slashOnKeyDown(event)
  return true
}

function handleArrowHistory<TEvent extends EditorKeyEvent>(deps: EditorKeymapDeps<TEvent>, event: TEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey) return false
  if (!deps.getCaretState().collapsed) return false
  const cursorPosition = getCursorPosition(deps.editor())
  const direction = event.key === "ArrowUp" ? "up" : "down"
  if (!canNavigateHistoryAtCursor(direction, deps.promptText(), cursorPosition, deps.historyActive())) return false
  return deps.navigateHistory(direction)
}

type KeyHandler = <TEvent extends EditorKeyEvent>(deps: EditorKeymapDeps<TEvent>, event: TEvent) => boolean

const plainCtrl = (event: EditorKeyEvent) => event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey

const pickFiles: KeyHandler = (deps, event) => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "u") return false
  event.preventDefault()
  if (deps.mode() === "normal") deps.pick()
  return true
}

const enterShell: KeyHandler = (deps, event) => {
  if (event.key !== "!" || deps.mode() !== "normal" || getCursorPosition(deps.editor()) !== 0) return false
  deps.setMode("shell")
  event.preventDefault()
  return true
}

const escapeKey: KeyHandler = (deps, event) => {
  if (event.key !== "Escape" || !handleEscape(deps)) return false
  event.preventDefault()
  event.stopPropagation()
  return true
}

const leaveShell: KeyHandler = (deps, event) => {
  if (deps.mode() !== "shell" || event.key !== "Backspace") return false
  const { collapsed, cursorPosition, textLength } = deps.getCaretState()
  if (!collapsed || cursorPosition !== 0 || textLength !== 0) return false
  deps.setMode("normal")
  event.preventDefault()
  return true
}

const newline: KeyHandler = (deps, event) => {
  if (event.key !== "Enter" || !event.shiftKey) return false
  deps.addTextPart("\n")
  event.preventDefault()
  return true
}

const composingEnter: KeyHandler = (deps, event) => event.key === "Enter" && deps.isImeComposing(event)

const popoverKeys: KeyHandler = (deps, event) => {
  if (!deps.popover() || !handlePopoverKey(deps, event, plainCtrl(event))) return false
  event.preventDefault()
  return true
}

const cancelKey: KeyHandler = (deps, event) => {
  if (!plainCtrl(event) || event.code !== "KeyG") return false
  if (deps.popover()) {
    deps.closePopover()
    event.preventDefault()
    return true
  }
  if (deps.stoppable()) {
    deps.abort()
    event.preventDefault()
  }
  return true
}

const historyArrows: KeyHandler = (deps, event) => {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false
  if (handleArrowHistory(deps, event)) event.preventDefault()
  return true
}

const submit: KeyHandler = (deps, event) => {
  if (event.key !== "Enter" || event.shiftKey) return false
  event.preventDefault()
  if (event.repeat || deps.booting() || (deps.working() && deps.blank())) return true
  void deps.handleSubmit(event)
  return true
}

const HANDLERS: readonly KeyHandler[] = [pickFiles, enterShell, escapeKey, leaveShell, newline, composingEnter, popoverKeys, cancelKey, historyArrows, submit]

export function createEditorKeyDown<TEvent extends EditorKeyEvent>(deps: EditorKeymapDeps<TEvent>) {
  return (event: TEvent) => {
    if (event.key === "Backspace") moveBeforeZeroWidthSentinel()
    for (const handler of HANDLERS) if (handler(deps, event)) return
  }
}

export function moveBeforeZeroWidthSentinel() {
  const selection = window.getSelection()
  if (!selection?.isCollapsed) return

  const node = selection.anchorNode
  const offset = selection.anchorOffset
  if (!node || node.nodeType !== Node.TEXT_NODE) return

  const text = node.textContent ?? ""
  if (!/^​+$/.test(text) || offset <= 0) return

  const range = document.createRange()
  range.setStart(node, 0)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}
