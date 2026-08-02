import { beforeEach, describe, expect, test } from "bun:test"
import { handleDocumentSearchKeydown } from "./search-keydown"

// The helper mutates a real `<input>` (value + selection range) rather than
// driving a signal, so these tests need DOM globals. `bun test` preloads
// happydom.ts, which registers them.

let input: HTMLInputElement
let row: HTMLButtonElement
let value: string

const setValue = (next: string) => {
  value = next
}

const press = (init: KeyboardEventInit & { key: string }, target: Element = row) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, "target", { value: target, configurable: true })
  const handled = handleDocumentSearchKeydown(input, event, value, setValue)
  return { handled, event }
}

const caret = () => [input.selectionStart, input.selectionEnd] as const

beforeEach(() => {
  document.body.innerHTML = ""
  input = document.createElement("input")
  row = document.createElement("button")
  document.body.append(input, row)
  value = ""
  input.value = ""
})

describe("handleDocumentSearchKeydown — when it declines to act", () => {
  test("returns false with no input to type into", () => {
    const event = new KeyboardEvent("keydown", { key: "a" })
    expect(handleDocumentSearchKeydown(undefined, event, "", setValue)).toBe(false)
  })

  test("returns false when the event already has a handler", () => {
    const event = new KeyboardEvent("keydown", { key: "a", cancelable: true })
    Object.defineProperty(event, "target", { value: row, configurable: true })
    event.preventDefault()
    expect(handleDocumentSearchKeydown(input, event, "", setValue)).toBe(false)
  })

  test("returns false while an IME composition is in flight", () => {
    expect(press({ key: "a", isComposing: true }).handled).toBe(false)
  })

  test("returns false when the search input is itself the target", () => {
    // The browser already types into a focused input; doing it again would
    // double every keystroke.
    expect(press({ key: "a" }, input).handled).toBe(false)
    expect(value).toBe("")
  })

  test("returns false when the target is another editable element", () => {
    const editor = document.createElement("div")
    editor.setAttribute("contenteditable", "true")
    document.body.append(editor)
    expect(press({ key: "a" }, editor).handled).toBe(false)
    expect(value).toBe("")
  })

  test("returns false for keys with no search meaning", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab", "PageDown"]) {
      expect(press({ key }).handled).toBe(false)
    }
    expect(value).toBe("")
  })

  test("returns false for modified keys other than select-all", () => {
    expect(press({ key: "b", metaKey: true }).handled).toBe(false)
    expect(press({ key: "b", ctrlKey: true }).handled).toBe(false)
    expect(press({ key: "b", altKey: true }).handled).toBe(false)
    // Alt+A is a shortcut, not select-all.
    expect(press({ key: "a", metaKey: true, altKey: true }).handled).toBe(false)
    expect(value).toBe("")
  })
})

describe("handleDocumentSearchKeydown — insertion", () => {
  test("inserts a printable key, focuses the input, and swallows the event", () => {
    const { handled, event } = press({ key: "r" })
    expect(handled).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(input)
    expect(value).toBe("r")
    expect(input.value).toBe("r")
    expect(caret()).toEqual([1, 1])
  })

  test("inserts a space", () => {
    press({ key: " " })
    expect(value).toBe(" ")
  })

  test("inserts at the caret rather than appending", () => {
    value = "repo"
    input.value = "repo"
    input.setSelectionRange(2, 2)
    press({ key: "X" })
    expect(value).toBe("reXpo")
    expect(caret()).toEqual([3, 3])
  })

  test("replaces the selection", () => {
    value = "repo"
    input.value = "repo"
    input.setSelectionRange(1, 3)
    press({ key: "u" })
    expect(value).toBe("ruo")
    expect(caret()).toEqual([2, 2])
  })
})

describe("handleDocumentSearchKeydown — deletion", () => {
  test("Backspace removes the character before the caret", () => {
    value = "repo"
    input.value = "repo"
    input.setSelectionRange(4, 4)
    press({ key: "Backspace" })
    expect(value).toBe("rep")
    expect(caret()).toEqual([3, 3])
  })

  test("Backspace at the start is a no-op that still consumes the key", () => {
    value = "repo"
    input.value = "repo"
    input.setSelectionRange(0, 0)
    expect(press({ key: "Backspace" }).handled).toBe(true)
    expect(value).toBe("repo")
  })

  test("Backspace with a selection deletes the selection only", () => {
    value = "repo"
    input.value = "repo"
    input.setSelectionRange(1, 3)
    press({ key: "Backspace" })
    expect(value).toBe("ro")
    expect(caret()).toEqual([1, 1])
  })

  test("Delete removes the character after the caret", () => {
    value = "repo"
    input.value = "repo"
    input.setSelectionRange(1, 1)
    press({ key: "Delete" })
    expect(value).toBe("rpo")
    expect(caret()).toEqual([1, 1])
  })

  test("Delete at the end is a no-op that still consumes the key", () => {
    value = "repo"
    input.value = "repo"
    input.setSelectionRange(4, 4)
    expect(press({ key: "Delete" }).handled).toBe(true)
    expect(value).toBe("repo")
  })
})

describe("handleDocumentSearchKeydown — caret movement", () => {
  beforeEach(() => {
    value = "repo"
    input.value = "repo"
  })

  test("ArrowLeft moves the caret without changing the value", () => {
    input.setSelectionRange(3, 3)
    expect(press({ key: "ArrowLeft" }).handled).toBe(true)
    expect(caret()).toEqual([2, 2])
    expect(value).toBe("repo")
  })

  test("ArrowRight clamps at the end", () => {
    input.setSelectionRange(4, 4)
    press({ key: "ArrowRight" })
    expect(caret()).toEqual([4, 4])
  })

  test("ArrowLeft collapses an existing selection to its start", () => {
    input.setSelectionRange(1, 3)
    press({ key: "ArrowLeft" })
    expect(caret()).toEqual([1, 1])
  })

  test("ArrowRight collapses an existing selection to its end", () => {
    input.setSelectionRange(1, 3)
    press({ key: "ArrowRight" })
    expect(caret()).toEqual([3, 3])
  })

  test("Shift+ArrowLeft extends the selection backward", () => {
    input.setSelectionRange(4, 4)
    press({ key: "ArrowLeft", shiftKey: true })
    expect(caret()).toEqual([3, 4])
    expect(input.selectionDirection).toBe("backward")
  })

  test("Shift+ArrowRight extends a backward selection back toward its anchor", () => {
    input.setSelectionRange(2, 4, "backward")
    press({ key: "ArrowRight", shiftKey: true })
    expect(caret()).toEqual([3, 4])
  })

  test("Home collapses to the start; End collapses to the end", () => {
    input.setSelectionRange(2, 2)
    press({ key: "Home" })
    expect(caret()).toEqual([0, 0])
    press({ key: "End" })
    expect(caret()).toEqual([4, 4])
  })

  test("Shift+Home selects to the start", () => {
    input.setSelectionRange(2, 2)
    press({ key: "Home", shiftKey: true })
    expect(caret()).toEqual([0, 2])
    expect(input.selectionDirection).toBe("backward")
  })

  test("Shift+End selects to the end", () => {
    input.setSelectionRange(2, 2)
    press({ key: "End", shiftKey: true })
    expect(caret()).toEqual([2, 4])
  })
})

describe("handleDocumentSearchKeydown — select all", () => {
  test("Meta+A selects the whole query without editing it", () => {
    value = "repo"
    input.value = "repo"
    input.setSelectionRange(1, 1)
    expect(press({ key: "a", metaKey: true }).handled).toBe(true)
    expect(caret()).toEqual([0, 4])
    expect(value).toBe("repo")
  })

  test("Ctrl+A works too, and is case-insensitive on the key", () => {
    value = "repo"
    input.value = "repo"
    press({ key: "A", ctrlKey: true })
    expect(caret()).toEqual([0, 4])
  })
})
