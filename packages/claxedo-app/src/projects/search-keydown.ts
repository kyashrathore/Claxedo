import { unreachable } from "@/lib/machine"
const editableSelector = "input, textarea, select, [contenteditable=''], [contenteditable='true']"

type Setter = (value: string) => void

type SearchKeyAction = NonNullable<ReturnType<typeof searchKeyAction>>

export function handleDocumentSearchKeydown(
  input: HTMLInputElement | undefined,
  event: KeyboardEvent,
  inputValue: string,
  setInputValue: Setter,
) {
  if (!input) return false
  if (event.defaultPrevented || event.isComposing) return false
  if (event.target === input) return false
  if (event.target instanceof Element && event.target.closest(editableSelector)) return false

  const action = searchKeyAction(event)
  if (!action) return false

  event.preventDefault()
  event.stopPropagation()
  input.focus()
  return applySearchKey(input, action, inputValue, event.shiftKey, setInputValue)
}

function applySearchKey(input: HTMLInputElement, action: SearchKeyAction, inputValue: string, extend: boolean, setInputValue: Setter) {
  const start = input.selectionStart ?? inputValue.length
  const end = input.selectionEnd ?? inputValue.length
  switch (action.type) {
    case "selectAll":
      input.setSelectionRange(0, inputValue.length)
      return true
    case "move":
      moveSelection(input, inputValue, action.delta, extend)
      return true
    case "home":
      setBoundarySelection(input, start, 0, extend)
      return true
    case "end":
      setBoundarySelection(input, start, inputValue.length, extend)
      return true
    case "deleteBackward":
      return deleteBackward(input, inputValue, start, end, setInputValue)
    case "deleteForward":
      return deleteForward(input, inputValue, start, end, setInputValue)
    case "insert":
      return updateValue(input, inputValue.slice(0, start) + action.value + inputValue.slice(end), start + action.value.length, setInputValue)
    default:
      return unreachable(action)
  }
}

function deleteBackward(input: HTMLInputElement, value: string, start: number, end: number, setInputValue: Setter) {
  if (start !== end) return updateValue(input, value.slice(0, start) + value.slice(end), start, setInputValue)
  if (start === 0) return true
  return updateValue(input, value.slice(0, start - 1) + value.slice(end), start - 1, setInputValue)
}

function deleteForward(input: HTMLInputElement, value: string, start: number, end: number, setInputValue: Setter) {
  if (start !== end) return updateValue(input, value.slice(0, start) + value.slice(end), start, setInputValue)
  if (end === value.length) return true
  return updateValue(input, value.slice(0, start) + value.slice(end + 1), start, setInputValue)
}

function searchKeyAction(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "a") {
    return { type: "selectAll" } as const
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return undefined
  if (event.key.length === 1) return { type: "insert", value: event.key } as const
  if (event.key === "Backspace") return { type: "deleteBackward" } as const
  if (event.key === "Delete") return { type: "deleteForward" } as const
  if (event.key === "ArrowLeft") return { type: "move", delta: -1 } as const
  if (event.key === "ArrowRight") return { type: "move", delta: 1 } as const
  if (event.key === "Home") return { type: "home" } as const
  if (event.key === "End") return { type: "end" } as const
  return undefined
}

function moveSelection(input: HTMLInputElement, inputValue: string, delta: -1 | 1, extend: boolean) {
  const start = input.selectionStart ?? inputValue.length
  const end = input.selectionEnd ?? inputValue.length
  if (!extend && start !== end) {
    const caret = delta < 0 ? start : end
    input.setSelectionRange(caret, caret)
    return
  }

  if (!extend) {
    const caret = Math.max(0, Math.min(inputValue.length, start + delta))
    input.setSelectionRange(caret, caret)
    return
  }

  const backward = input.selectionDirection === "backward"
  const anchor = backward ? end : start
  const focus = backward ? start : end
  const next = Math.max(0, Math.min(inputValue.length, focus + delta))
  input.setSelectionRange(Math.min(anchor, next), Math.max(anchor, next), next < anchor ? "backward" : "forward")
}

function setBoundarySelection(input: HTMLInputElement, anchor: number, focus: number, extend: boolean) {
  if (!extend) {
    input.setSelectionRange(focus, focus)
    return
  }
  input.setSelectionRange(Math.min(anchor, focus), Math.max(anchor, focus), focus < anchor ? "backward" : "forward")
}

function updateValue(input: HTMLInputElement, value: string, caret: number, setInputValue: Setter) {
  input.value = value
  setInputValue(value)
  input.setSelectionRange(caret, caret)
  return true
}
