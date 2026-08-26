import { createEffect, type Accessor } from "solid-js"
import type { usePrompt } from "@/features/session/providers/prompt"
import { getCursorPosition, setCursorPosition } from "@/features/session/composer/ui/editor-dom"
import { promptLength, type PromptHistoryEntry } from "@/features/session/composer/ui/history"
import { PROMPT_EXAMPLES } from "@/features/session/composer/examples"
import type { PromptInputProps } from "@/features/session/composer/prompt-input-props"

type PromptController = ReturnType<typeof usePrompt>
type PromptMode = "normal" | "shell"

export function promptCaretState(input: { editor: Accessor<HTMLDivElement>; prompt: PromptController }) {
  const selection = window.getSelection()
  const textLength = promptLength(input.prompt.current())
  if (!selection || selection.rangeCount === 0) return { collapsed: false, cursorPosition: 0, textLength }

  const anchorNode = selection.anchorNode
  if (!anchorNode || !input.editor().contains(anchorNode)) {
    return { collapsed: false, cursorPosition: 0, textLength }
  }

  return {
    collapsed: selection.isCollapsed,
    cursorPosition: getCursorPosition(input.editor()),
    textLength,
  }
}

export function createPromptExampleRotation(input: {
  disabled: Accessor<boolean>
  setPlaceholder: (next: (previous: number) => number) => void
}) {
  createEffect(input.disabled, (disabled) => {
    if (disabled) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const rotatePlaceholder = () => {
      input.setPlaceholder((prev) => (prev + 1) % PROMPT_EXAMPLES.length)
      timer = setTimeout(rotatePlaceholder, 6500)
    }
    timer = setTimeout(rotatePlaceholder, 6500)
    return () => clearTimeout(timer)
  })
}

export function createPromptEditLoader(input: {
  edit: Accessor<PromptInputProps["edit"]>
  prompt: PromptController
  editor: Accessor<HTMLDivElement>
  queueScroll: VoidFunction
  setMode: (mode: PromptMode) => void
  setPopover: (popover: "at" | "slash" | null) => void
  setHistoryIndex: (index: number) => void
  setSavedPrompt: (prompt: PromptHistoryEntry | null) => void
  onEditLoaded: VoidFunction | undefined
}) {
  createEffect(
    () => input.edit()?.id,
    (id) => {
      const edit = input.edit()
      if (!id || !edit) return

      for (const item of input.prompt.context.items()) {
        input.prompt.context.remove(item.key)
      }

      for (const item of edit.context) {
        input.prompt.context.add({
          type: item.type,
          path: item.path,
          selection: item.selection,
          comment: item.comment,
          commentID: item.commentID,
          commentOrigin: item.commentOrigin,
          preview: item.preview,
        })
      }

      input.setMode("normal")
      input.setPopover(null)
      input.setHistoryIndex(-1)
      input.setSavedPrompt(null)
      input.prompt.set(edit.prompt, promptLength(edit.prompt))
      requestAnimationFrame(() => {
        input.editor().focus()
        setCursorPosition(input.editor(), promptLength(edit.prompt))
        input.queueScroll()
      })
      input.onEditLoaded?.()
    },
    { defer: true },
  )
}
