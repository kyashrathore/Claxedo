import { describe, expect, test } from "bun:test"
import { setCursorPosition } from "@/components/prompt-input/editor-dom"
import { createPromptInputKeyDown, type PromptInputKeyEvent } from "./editor-keymap"

type Mode = "normal" | "shell"
type Popover = "at" | "slash" | null

function keyEvent(input: Partial<PromptInputKeyEvent> & { key: string }) {
  const calls = {
    preventDefault: 0,
    stopPropagation: 0,
  }
  const event: PromptInputKeyEvent = {
    altKey: false,
    code: "",
    ctrlKey: false,
    isComposing: false,
    keyCode: 0,
    metaKey: false,
    repeat: false,
    shiftKey: false,
    ...input,
    preventDefault: () => {
      calls.preventDefault += 1
    },
    stopPropagation: () => {
      calls.stopPropagation += 1
    },
  }
  return { event, calls }
}

function editorWithText(text = "") {
  const editor = document.createElement("div")
  editor.textContent = text
  document.body.appendChild(editor)
  setCursorPosition(editor, 0)
  return editor
}

function createHarness(editor = editorWithText()) {
  const calls: string[] = []
  const state = {
    mode: "normal" as Mode,
    popover: null as Popover,
    caret: { collapsed: true, cursorPosition: 0, textLength: 0 },
    stoppable: false,
    escBlur: false,
    booting: false,
    working: false,
    blank: false,
    promptText: "",
    historyActive: false,
    ime: false,
    historyResult: true,
  }
  const handleKeyDown = createPromptInputKeyDown({
    editor: () => editor,
    mode: () => state.mode,
    setMode: (mode) => {
      state.mode = mode
      state.popover = null
      calls.push(`mode:${mode}`)
    },
    popover: () => state.popover,
    closePopover: () => {
      state.popover = null
      calls.push("close-popover")
    },
    pick: () => calls.push("pick"),
    getCaretState: () => state.caret,
    isImeComposing: () => state.ime,
    addTextPart: (content) => calls.push(`add:${content}`),
    selectPopoverActive: () => calls.push("select-popover"),
    atOnKeyDown: () => calls.push("at-keydown"),
    slashOnKeyDown: () => calls.push("slash-keydown"),
    stoppable: () => state.stoppable,
    abort: () => calls.push("abort"),
    escBlur: () => state.escBlur,
    booting: () => state.booting,
    working: () => state.working,
    blank: () => state.blank,
    promptText: () => state.promptText,
    historyActive: () => state.historyActive,
    navigateHistory: (direction) => {
      calls.push(`history:${direction}`)
      return state.historyResult
    },
    handleSubmit: () => calls.push("submit"),
  })
  return { calls, editor, handleKeyDown, state }
}

describe("prompt input keymap", () => {
  test("mod-u picks files only in normal mode", () => {
    const harness = createHarness()
    const normal = keyEvent({ key: "u", metaKey: true })
    harness.handleKeyDown(normal.event)

    expect(harness.calls).toEqual(["pick"])
    expect(normal.calls.preventDefault).toBe(1)

    harness.calls.length = 0
    harness.state.mode = "shell"
    const shell = keyEvent({ key: "u", metaKey: true })
    harness.handleKeyDown(shell.event)

    expect(harness.calls).toEqual([])
    expect(shell.calls.preventDefault).toBe(1)
  })

  test("bang at the start switches to shell mode", () => {
    const harness = createHarness()
    const event = keyEvent({ key: "!" })
    harness.handleKeyDown(event.event)

    expect(harness.state.mode).toBe("shell")
    expect(harness.calls).toEqual(["mode:shell"])
    expect(event.calls.preventDefault).toBe(1)
  })

  test("escape follows popover shell abort blur priority", () => {
    const harness = createHarness()

    harness.state.popover = "at"
    const popover = keyEvent({ key: "Escape" })
    harness.handleKeyDown(popover.event)
    expect(harness.calls).toEqual(["close-popover"])
    expect(popover.calls.preventDefault).toBe(1)
    expect(popover.calls.stopPropagation).toBe(1)

    harness.calls.length = 0
    harness.state.mode = "shell"
    const shell = keyEvent({ key: "Escape" })
    harness.handleKeyDown(shell.event)
    expect(harness.calls).toEqual(["mode:normal"])
    expect(shell.calls.preventDefault).toBe(1)
    expect(shell.calls.stopPropagation).toBe(1)

    harness.calls.length = 0
    harness.state.stoppable = true
    const abort = keyEvent({ key: "Escape" })
    harness.handleKeyDown(abort.event)
    expect(harness.calls).toEqual(["abort"])
    expect(abort.calls.preventDefault).toBe(1)
    expect(abort.calls.stopPropagation).toBe(1)

    harness.calls.length = 0
    harness.state.stoppable = false
    harness.state.escBlur = true
    harness.editor.focus()
    const blur = keyEvent({ key: "Escape" })
    harness.handleKeyDown(blur.event)
    expect(document.activeElement).not.toBe(harness.editor)
    expect(blur.calls.preventDefault).toBe(1)
    expect(blur.calls.stopPropagation).toBe(1)
  })

  test("shift-enter inserts a newline before IME handling", () => {
    const harness = createHarness()
    harness.state.ime = true
    const event = keyEvent({ key: "Enter", shiftKey: true })
    harness.handleKeyDown(event.event)

    expect(harness.calls).toEqual(["add:\n"])
    expect(event.calls.preventDefault).toBe(1)
  })

  test("popover navigation delegates to the active list", () => {
    const harness = createHarness()

    harness.state.popover = "at"
    const at = keyEvent({ key: "ArrowDown" })
    harness.handleKeyDown(at.event)
    expect(harness.calls).toEqual(["at-keydown"])
    expect(at.calls.preventDefault).toBe(1)

    harness.calls.length = 0
    harness.state.popover = "slash"
    const slash = keyEvent({ key: "n", ctrlKey: true, code: "KeyN" })
    harness.handleKeyDown(slash.event)
    expect(harness.calls).toEqual(["slash-keydown"])
    expect(slash.calls.preventDefault).toBe(1)

    harness.calls.length = 0
    const tab = keyEvent({ key: "Tab" })
    harness.handleKeyDown(tab.event)
    expect(harness.calls).toEqual(["select-popover"])
    expect(tab.calls.preventDefault).toBe(1)
  })

  test("arrow keys navigate history only from allowed cursor positions", () => {
    const harness = createHarness()
    const blocked = keyEvent({ key: "ArrowUp" })
    harness.state.promptText = "not empty"
    harness.handleKeyDown(blocked.event)

    expect(harness.calls).toEqual([])
    expect(blocked.calls.preventDefault).toBe(0)

    const allowed = keyEvent({ key: "ArrowDown" })
    harness.state.promptText = "abc"
    harness.state.historyActive = true
    setCursorPosition(harness.editor, 3)
    harness.handleKeyDown(allowed.event)

    expect(harness.calls).toEqual(["history:down"])
    expect(allowed.calls.preventDefault).toBe(1)
  })

  test("enter submit respects repeat, boot, and busy-blank guards", () => {
    const harness = createHarness()
    const repeat = keyEvent({ key: "Enter", repeat: true })
    harness.handleKeyDown(repeat.event)
    expect(harness.calls).toEqual([])
    expect(repeat.calls.preventDefault).toBe(1)

    harness.state.booting = true
    const booting = keyEvent({ key: "Enter" })
    harness.handleKeyDown(booting.event)
    expect(harness.calls).toEqual([])

    harness.state.booting = false
    harness.state.working = true
    harness.state.blank = true
    const busyBlank = keyEvent({ key: "Enter" })
    harness.handleKeyDown(busyBlank.event)
    expect(harness.calls).toEqual([])

    harness.state.working = false
    const submit = keyEvent({ key: "Enter" })
    harness.handleKeyDown(submit.event)
    expect(harness.calls).toEqual(["submit"])
    expect(submit.calls.preventDefault).toBe(1)
  })
})
