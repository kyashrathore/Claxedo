import type { Prompt, PromptDraftScope } from "@/features/session/providers/prompt"
import type { SubmitMode } from "../../submit/index"
import { setCursorPosition } from "./editor-dom"

type PromptWriter = {
  reset(scope?: PromptDraftScope): void
  set(value: Prompt, cursorPosition?: number, scope?: PromptDraftScope): void
}

export function createSubmitDraftLifecycle(input: {
  prompt: PromptWriter
  current: Prompt
  scopes: PromptDraftScope[]
  /** The draft whose recall stack the send joins: the session it went to. */
  historyScope: PromptDraftScope
  addToHistory: (prompt: Prompt, mode: SubmitMode, scope: PromptDraftScope) => void
  resetHistoryNavigation: VoidFunction
  length: (prompt: Prompt) => number
  userMode: SubmitMode
  setMode: (mode: SubmitMode) => void
  setPopover: (popover: "at" | "slash" | null) => void
  editor: () => HTMLDivElement | undefined
  queueScroll: VoidFunction
}) {
  const focus = (position: number) => requestAnimationFrame(() => {
    const editor = input.editor()
    if (!editor) return
    editor.focus()
    setCursorPosition(editor, position)
    input.queueScroll()
  })
  // Recorded here rather than before the send so a first send from a `draft:`
  // scope lands in the history of the session it created, which does not exist
  // until the send resolves. A failed send restores the draft instead.
  const clear = () => {
    input.addToHistory(input.current, input.userMode, input.historyScope)
    input.resetHistoryNavigation()
    for (const scope of input.scopes) input.prompt.reset(scope)
    input.setMode("normal")
    input.setPopover(null)
  }
  const restore = () => {
    const position = input.length(input.current)
    for (const scope of input.scopes) input.prompt.set(input.current, position, scope)
    input.setMode(input.userMode)
    input.setPopover(null)
    focus(position)
  }
  const restoreGoal = (objective: string, submittedText: string) => {
    if (submittedText.trimStart().toLowerCase().startsWith("/goal")) return restore()
    const text = `/goal ${objective}`
    const retry: Prompt = [
      { type: "text", content: text, start: 0, end: text.length },
      ...input.current.filter((part) => part.type !== "text"),
    ]
    for (const scope of input.scopes) input.prompt.set(retry, text.length, scope)
    input.setMode("normal")
    input.setPopover(null)
    focus(text.length)
  }
  return { clear, restore, restoreGoal }
}
