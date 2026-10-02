import { createMemo } from "solid-js"
import type { EditorMode } from "./model"
import { promptFilled } from "./model"
import { createControllerContext, type ControllerContext, type ControllerInput } from "./controller-context"
import { createEditorSync } from "./editor-sync"
import { navigateComposerHistory } from "./history-navigation"
import {
  activeItems,
  closePopover,
  keepActiveItem,
  openCommands,
  openContext,
  popoverKeyDown,
  selectActive,
  selectAt,
  selectSlash,
  updatePopover,
} from "./popover-actions"
import { getCursorPosition } from "./editor/dom"
import { createEditorKeyDown, type PopoverKind } from "./editor/keymap"

function caretState(context: ControllerContext) {
  const editor = context.input.refs.editor()
  const selection = window.getSelection()
  return {
    collapsed: selection?.isCollapsed ?? true,
    cursorPosition: editor ? getCursorPosition(editor) : 0,
    textLength: context.text().length,
  }
}

function createKeyDown(context: ControllerContext, blank: () => boolean, setMode: (mode: EditorMode) => void, recordCursor: () => void) {
  const { input, state } = context
  const popover = (): PopoverKind => (state.popover.kind === "closed" ? null : state.popover.kind)
  return createEditorKeyDown<KeyboardEvent>({
    editor: () => input.refs.editor() ?? document.body,
    mode: () => state.mode,
    setMode,
    popover,
    closePopover: () => closePopover(context),
    pick: () => input.refs.fileInput()?.click(),
    getCaretState: () => caretState(context),
    isImeComposing: (event) => event.isComposing || state.composing,
    addTextPart: (content) => {
      recordCursor()
      input.store.addPart(input.key(), { type: "text", content, start: 0, end: 0 })
    },
    selectPopoverActive: () => selectActive(context),
    atOnKeyDown: (event) => popoverKeyDown(context, event),
    slashOnKeyDown: (event) => popoverKeyDown(context, event),
    stoppable: input.working,
    abort: input.stop,
    escBlur: () => false,
    booting: () => false,
    working: input.working,
    blank,
    promptText: context.text,
    historyActive: () => state.historyIndex >= 0,
    navigateHistory: (direction) => navigateComposerHistory(context, direction),
    handleSubmit: () => input.submit(),
  })
}

function leaveHistory(context: ReturnType<typeof createControllerContext>) {
  closePopover(context)
  context.setState({ historyIndex: -1, savedPrompt: null })
}

export function createComposerController(input: ControllerInput) {
  const context = createControllerContext(input)
  const { state, setState } = context
  const blank = createMemo(() => !promptFilled(context.draft()))
  const setMode = (mode: EditorMode) => {
    if (mode === "shell" && input.shellEnabled?.() === false) return
    setState("mode", mode)
    closePopover(context)
  }
  keepActiveItem(context)
  const sync = createEditorSync(context, (value, cursor) => updatePopover(context, value, cursor), () => leaveHistory(context))
  return {
    state,
    text: context.text,
    blank,
    suggestionQuery: createMemo(() => state.popover),
    activeItems: () => activeItems(context),
    onInput: sync.onInput,
    onKeyDown: createKeyDown(context, blank, setMode, sync.recordCursor),
    setComposing: (composing: boolean) => setState("composing", composing),
    setFocused: (focused: boolean) => {
      setState("focused", focused)
      if (!focused) closePopover(context)
    },
    setActive: (id: string) => setState("activeId", id),
    selectAt: (item: Parameters<typeof selectAt>[1]) => selectAt(context, item),
    selectSlash: (item: Parameters<typeof selectSlash>[1]) => selectSlash(context, item),
    closePopover: () => closePopover(context),
    setMode,
    openCommands: () => openCommands(context),
    openContext: () => openContext(context),
    resetHistory: () => setState({ historyIndex: -1, savedPrompt: null }),
    focusEditor: context.focusEditor,
  }
}

export type ComposerController = ReturnType<typeof createComposerController>
