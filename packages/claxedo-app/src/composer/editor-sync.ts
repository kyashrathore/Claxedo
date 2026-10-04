import { createEffect, on, onCleanup } from "solid-js"
import type { ControllerContext } from "./controller-context"
import { emptyPrompt, promptImages, promptText } from "./model"
import { getCursorPosition, setCursorPosition } from "./editor/dom"
import { parsePromptEditor, renderPromptEditor } from "./editor/serialization"

const NON_EMPTY_TEXT = /[^\s\u200B]/

type Echo = { localInput: boolean }

export function createEditorSync(context: ControllerContext, updatePopover: (value: string, cursor: number) => void, reset: () => void) {
  const { input, draft, text } = context
  const echo: Echo = { localInput: false }
  createEffect(
    on(
      () => [draft().prompt, input.key()] as const,
      () => {
        const editor = input.refs.editor()
        if (!editor) return
        if (echo.localInput) {
          echo.localInput = false
          return
        }
        renderPromptEditor(editor, draft().prompt)
        if (document.activeElement === editor) setCursorPosition(editor, draft().cursor ?? text().length)
      },
    ),
  )
  const recordCursor = () => {
    const editor = input.refs.editor()
    const selection = window.getSelection()
    if (!editor || !selection?.isCollapsed || !selection.anchorNode || !editor.contains(selection.anchorNode)) return
    const cursor = getCursorPosition(editor)
    if (cursor !== draft().cursor) input.store.setCursor(input.key(), cursor)
  }
  document.addEventListener("selectionchange", recordCursor)
  onCleanup(() => document.removeEventListener("selectionchange", recordCursor))
  return {
    onInput: () => readEditorInput(context, echo, { updatePopover, reset }),
    recordCursor,
  }
}

function readEditorInput(context: ControllerContext, echo: Echo, after: { updatePopover: (value: string, cursor: number) => void; reset: () => void }) {
  const { input, draft } = context
  const editor = input.refs.editor()
  if (!editor) return
  const parsed = parsePromptEditor(editor)
  const cursor = getCursorPosition(editor)
  const images = promptImages(draft().prompt)
  if (!NON_EMPTY_TEXT.test(promptText(parsed)) && parsed.every((part) => part.type === "text") && images.length === 0) {
    after.reset()
    if (promptText(draft().prompt)) input.store.setPrompt(input.key(), emptyPrompt(), 0)
    input.edited()
    return
  }
  echo.localInput = true
  input.store.setPrompt(input.key(), [...parsed, ...images], cursor)
  input.edited()
  after.updatePopover(promptText(parsed), cursor)
}
