import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { ImageAttachmentPart, Prompt } from "@/context/prompt"
import { setCursorPosition } from "@/components/prompt-input/editor-dom"
import { createPromptEditorActions } from "./editor-actions"

function createHarness() {
  const editor = document.createElement("div")
  document.body.appendChild(editor)

  let promptValue: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]
  let cursor: number | undefined = 0
  let dirty = true
  let mode: "normal" | "shell" = "normal"
  let images: ImageAttachmentPart[] = []
  const calls = {
    atQueries: [] as string[],
    popovers: [] as Array<"at" | "slash" | null>,
    resetHistory: 0,
    scroll: 0,
    slashQueries: [] as string[],
    slashTriggers: [] as string[],
  }
  const actions = createPromptEditorActions({
    editor: () => editor,
    prompt: {
      current: () => promptValue,
      cursor: () => cursor,
      dirty: () => dirty,
      set: (next, nextCursor) => {
        promptValue = next
        cursor = nextCursor
      },
    },
    imageAttachments: () => images,
    mode: () => mode,
    setPopover: (popover) => calls.popovers.push(popover),
    resetHistoryNavigation: () => {
      calls.resetHistory++
    },
    queueScroll: () => {
      calls.scroll++
    },
    promptLength: (prompt) => prompt.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
    atOnInput: (query) => calls.atQueries.push(query),
    slashOnInput: (query) => calls.slashQueries.push(query),
    triggerSlashCommand: (id) => calls.slashTriggers.push(id),
  })
  return {
    actions,
    calls,
    editor,
    setDirty: (next: boolean) => {
      dirty = next
    },
    setImages: (next: ImageAttachmentPart[]) => {
      images = next
    },
    setMode: (next: "normal" | "shell") => {
      mode = next
    },
    setPrompt: (next: Prompt, nextCursor?: number) => {
      promptValue = next
      cursor = nextCursor
    },
    prompt: () => promptValue,
  }
}

describe("prompt editor actions", () => {
  test("empty input resets dirty prompt to the default prompt", () => {
    createRoot((dispose) => {
      const harness = createHarness()
      harness.editor.textContent = "   "
      harness.actions.handleInput()

      expect(harness.prompt()).toEqual([{ type: "text", content: "", start: 0, end: 0 }])
      expect(harness.calls.popovers).toEqual([null])
      expect(harness.calls.resetHistory).toBe(1)
      expect(harness.calls.scroll).toBe(1)
      dispose()
    })
  })

  test("input opens at and slash popovers only in normal mode", () => {
    createRoot((dispose) => {
      const harness = createHarness()

      harness.editor.textContent = "@agent"
      setCursorPosition(harness.editor, 6)
      harness.actions.handleInput()
      expect(harness.calls.atQueries).toEqual(["agent"])
      expect(harness.calls.popovers.at(-1)).toBe("at")

      harness.editor.textContent = "/test"
      setCursorPosition(harness.editor, 5)
      harness.actions.handleInput()
      expect(harness.calls.slashQueries).toEqual(["test"])
      expect(harness.calls.popovers.at(-1)).toBe("slash")

      harness.setMode("shell")
      harness.editor.textContent = "@agent"
      setCursorPosition(harness.editor, 6)
      harness.actions.handleInput()
      expect(harness.calls.atQueries).toEqual(["agent"])
      expect(harness.calls.popovers.at(-1)).toBe(null)
      dispose()
    })
  })

  test("addPart replaces the active at-query with a pill and trailing space", () => {
    createRoot((dispose) => {
      const harness = createHarness()
      harness.editor.textContent = "ask @foo"
      harness.setPrompt([{ type: "text", content: "ask @foo", start: 0, end: 8 }], 8)
      setCursorPosition(harness.editor, 8)

      expect(harness.actions.addPart({ type: "agent", name: "agent", content: "@agent", start: 0, end: 0 })).toBe(true)

      expect(harness.prompt()).toEqual([
        { type: "text", content: "ask ", start: 0, end: 4 },
        { type: "agent", name: "agent", content: "@agent", start: 4, end: 10 },
        { type: "text", content: " ", start: 10, end: 11 },
      ])
      expect(harness.calls.popovers.at(-1)).toBe(null)
      dispose()
    })
  })

  test("slash selection writes custom commands and triggers builtin commands", () => {
    createRoot((dispose) => {
      const harness = createHarness()

      harness.actions.handleSlashSelect({
        id: "custom.deploy",
        trigger: "deploy",
        title: "deploy",
        type: "custom",
        source: "deploy",
      })
      expect(harness.editor.textContent).toBe("/deploy ")
      expect(harness.prompt()).toEqual([{ type: "text", content: "/deploy ", start: 0, end: 8 }])

      harness.editor.textContent = "/help"
      harness.actions.handleSlashSelect({
        id: "session.help",
        trigger: "help",
        title: "help",
        type: "builtin",
      })
      expect(harness.editor.textContent).toBe("")
      expect(harness.prompt()).toEqual([{ type: "text", content: "", start: 0, end: 0 }])
      expect(harness.calls.slashTriggers).toEqual(["session.help"])
      dispose()
    })
  })

  test("blur and composition state close editor interaction loops", () => {
    createRoot((dispose) => {
      const harness = createHarness()
      harness.actions.handleCompositionStart()
      expect(harness.actions.composing()).toBe(true)

      harness.actions.handleBlur()
      expect(harness.actions.composing()).toBe(false)
      expect(harness.calls.popovers).toEqual([null])
      dispose()
    })
  })
})
