import { createEffect, on } from "solid-js"
import type { ControllerContext } from "./controller-context"
import { promptImages, promptText } from "./model"
import { getCursorPosition, setCursorPosition } from "./editor/dom"
import { parsePromptEditor, renderPromptEditor } from "./editor/serialization"

export function createEditorSync(context: ControllerContext, updatePopover: (value: string, cursor: number) => void) {
  const { input, draft, text } = context
  let localInput = false
  createEffect(
    on(
      () => [draft().prompt, input.key()] as const,
      () => {
        const editor = input.refs.editor()
        if (!editor) return
        if (localInput) {
          localInput = false
          return
        }
        renderPromptEditor(editor, draft().prompt)
        if (document.activeElement === editor) setCursorPosition(editor, draft().cursor ?? text().length)
      },
    ),
  )
  return {
    onInput: () => {
      const editor = input.refs.editor()
      if (!editor) return
      const parsed = parsePromptEditor(editor)
      const cursor = getCursorPosition(editor)
      localInput = true
      input.store.setPrompt(input.key(), [...parsed, ...promptImages(draft().prompt)], cursor)
      input.edited()
      updatePopover(promptText(parsed), cursor)
    },
    onCursor: () => {
      const editor = input.refs.editor()
      if (editor && window.getSelection()?.isCollapsed) input.store.setCursor(input.key(), getCursorPosition(editor))
    },
  }
}
