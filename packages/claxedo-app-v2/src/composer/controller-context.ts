import { createMemo, type Accessor } from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"
import type { Draft, EditorMode, HistoryEntry } from "./model"
import { promptText } from "./model"
import type { ComposerRefs } from "./refs"
import type { ComposerKey, ComposerStore } from "./store"
import type { AtItem, SlashItem } from "./suggestions"
import { setCursorPosition } from "./editor/dom"

export type PopoverState =
  | { kind: "closed" }
  | { kind: "at"; query: string; start: number }
  | { kind: "slash"; query: string }

export type ControllerState = {
  mode: EditorMode
  popover: PopoverState
  activeId: string | undefined
  historyIndex: number
  savedPrompt: HistoryEntry | null
  composing: boolean
  focused: boolean
}

export type ControllerInput = {
  key: Accessor<ComposerKey>
  store: ComposerStore
  refs: ComposerRefs
  working: Accessor<boolean>
  atItems: Accessor<AtItem[]>
  slashItems: Accessor<SlashItem[]>
  submit: () => void
  stop: () => void
  edited: () => void
  armGoal: () => void
  runCommand: (item: SlashItem) => void
}

export type ControllerContext = {
  readonly input: ControllerInput
  readonly state: ControllerState
  readonly setState: SetStoreFunction<ControllerState>
  readonly draft: () => Draft
  readonly text: Accessor<string>
  readonly focusEditor: (cursor?: number) => void
}

export function createControllerContext(input: ControllerInput): ControllerContext {
  const [state, setState] = createStore<ControllerState>({
    mode: "normal",
    popover: { kind: "closed" },
    activeId: undefined,
    historyIndex: -1,
    savedPrompt: null,
    composing: false,
    focused: false,
  })
  const draft = () => input.store.draft(input.key())
  const text = createMemo(() => promptText(draft().prompt))
  const focusEditor = (cursor?: number) => {
    const editor = input.refs.editor()
    if (!editor) return
    editor.focus()
    setCursorPosition(editor, cursor ?? draft().cursor ?? text().length)
  }
  return { input, state, setState, draft, text, focusEditor }
}
