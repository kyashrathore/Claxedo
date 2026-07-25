// The LEGACY engine: Claxedo's own editor/popover/history machinery, moved
// verbatim out of `composer.tsx` behind the shared `ComposerEngine` contract
// (plan 2026-07-25-005, W3/T3.1). THIS IS THE DEFAULT PATH.
//
// Nothing here is new behaviour — it is the same `createPromptEditorActions` +
// `createPromptPopoverController` + `createPromptHistoryController` wiring the
// composer had inline, with the local popover/mode/history store it used to own.
// It stays until W5.2 deletes it, so a regression on the controller path is one
// flag away from being ruled out.
import { createEffect, on } from "solid-js"
import { createStore } from "solid-js/store"
import { createPromptEditorActions } from "@/features/session/composer/ui/editor-actions"
import { createPromptInputKeyDown } from "@/features/session/composer/ui/editor-keymap"
import { createPromptHistoryController } from "@/features/session/composer/ui/history-controller"
import { promptLength, type PromptHistoryEntry } from "@/features/session/composer/ui/history"
import { promptCaretState } from "@/features/session/composer/ui/lifecycle"
import { createPromptPopoverController, promptAtOptionKey } from "@/features/session/composer/ui/popover-controller"
import { setCursorPosition } from "@/features/session/composer/ui/editor-dom"
import type { ComposerEngine, ComposerEngineBuildInput } from "@/features/session/composer/v2/engine-contract"

export function createLegacyComposerEngine(input: ComposerEngineBuildInput): ComposerEngine {
  const documentPicker = input.documentPicker
  const [store, setStore] = createStore<{
    popover: "at" | "slash" | null
    historyIndex: number
    savedPrompt: PromptHistoryEntry | null
    draggingType: "image" | "@mention" | null
    mode: "normal" | "shell"
    applyingHistory: boolean
  }>({
    popover: null,
    historyIndex: -1,
    savedPrompt: null as PromptHistoryEntry | null,
    draggingType: null,
    mode: "normal",
    applyingHistory: false,
  })
  // Imperative, not reactive: it gates a one-shot caret restore on the first
  // focus after the editor element is (re)bound. Nothing renders from it.
  let restoreEndOnFocus = true

  const history = createPromptHistoryController({
    comments: input.comments,
    prompt: input.prompt,
    mode: () => store.mode,
    editor: input.editor,
    queueScroll: input.queueScroll,
    applyingHistory: () => store.applyingHistory,
    setApplyingHistory: (value) => setStore("applyingHistory", value),
    historyIndex: () => store.historyIndex,
    setHistoryIndex: (value) => setStore("historyIndex", value),
    savedPrompt: () => store.savedPrompt,
    setSavedPrompt: (value) => setStore("savedPrompt", value),
  })

  let editorActions!: ReturnType<typeof createPromptEditorActions>
  const popoverController = createPromptPopoverController({
    popover: () => store.popover,
    agents: input.agents,
    recentFiles: input.recentFiles,
    searchFilesAndDirectories: input.searchFilesAndDirectories,
    commandOptions: input.commandOptions,
    customCommands: input.customCommands,
    documentPicker: documentPicker.open,
    documents: documentPicker.documents,
    onAtSelect: (option) => editorActions.handleAtSelect(option),
    onSlashSelect: (command) => editorActions.handleSlashSelect(command),
  })

  editorActions = createPromptEditorActions({
    editor: input.editor,
    prompt: input.prompt,
    imageAttachments: input.imageAttachments,
    mode: () => store.mode,
    setPopover: (popover) => setStore("popover", popover),
    resetHistoryNavigation: history.resetHistoryNavigation,
    queueScroll: input.queueScroll,
    promptLength,
    atOnInput: popoverController.atOnInput,
    slashOnInput: popoverController.slashOnInput,
    triggerSlashCommand: input.triggerSlashCommand,
    openDocumentPicker: documentPicker.show,
    closeDocumentPicker: documentPicker.close,
    onDocumentSelect: (option) => documentPicker.select(option),
  })

  createEffect(
    on(
      () => input.prompt.current(),
      (parts) => {
        if (editorActions.composing()) return
        editorActions.reconcile(parts.filter((part) => part.type !== "image"))
      },
    ),
  )

  const handleKeyDown = createPromptInputKeyDown({
    editor: input.editor,
    mode: () => store.mode,
    setMode: (mode) => {
      setStore("mode", mode)
      setStore("popover", null)
    },
    popover: () => store.popover,
    closePopover: editorActions.closePopover,
    pick: input.pick,
    getCaretState: () => promptCaretState({ editor: input.editor, prompt: input.prompt }),
    isImeComposing: editorActions.isImeComposing,
    addTextPart: (content) => editorActions.addPart({ type: "text", content, start: 0, end: 0 }),
    selectPopoverActive: popoverController.selectPopoverActive,
    atOnKeyDown: popoverController.atOnKeyDown,
    slashOnKeyDown: popoverController.slashOnKeyDown,
    stoppable: input.stoppable,
    abort: input.abort,
    escBlur: input.escBlur,
    booting: input.booting,
    working: input.working,
    blank: input.blank,
    promptText: () =>
      input.prompt
        .current()
        .map((part) => ("content" in part ? part.content : ""))
        .join(""),
    historyActive: history.historyActive,
    navigateHistory: history.navigateHistory,
    handleSubmit: input.handleSubmit,
  })

  return {
    kind: "legacy",
    mode: () => store.mode,
    setMode: (mode) => setStore("mode", mode),
    enterMode: (mode) => {
      setStore("mode", mode)
      setStore("popover", null)
      requestAnimationFrame(() => input.editor().focus())
    },
    popover: () => store.popover,
    openPopover: editorActions.openPopover,
    openContextSurface: () => {
      popoverController.atOnInput("")
      setStore("popover", "at")
    },
    closePopover: editorActions.closePopover,
    draggingType: () => store.draggingType,
    setDraggingType: (type) => setStore("draggingType", type),
    addPart: editorActions.addPart,
    replaceText: editorActions.replaceText,
    bindEditor: () => {
      restoreEndOnFocus = true
    },
    handleFocus: () => {
      if (!restoreEndOnFocus) return
      restoreEndOnFocus = false
      requestAnimationFrame(() => {
        const editor = input.editor()
        if (document.activeElement !== editor) return
        setCursorPosition(editor, input.prompt.cursor() ?? promptLength(input.prompt.current()))
        input.queueScroll()
      })
    },
    handleInput: editorActions.handleInput,
    handleBlur: editorActions.handleBlur,
    handleCompositionStart: editorActions.handleCompositionStart,
    handleCompositionEnd: editorActions.handleCompositionEnd,
    handleKeyDown,
    addToHistory: history.addToHistory,
    resetHistoryNavigation: history.resetHistoryNavigation,
    documentPicker,
    popoverView: {
      setSlashPopoverRef: popoverController.setSlashPopoverRef,
      atFlat: popoverController.atFlat,
      atActive: () => popoverController.atActive() ?? undefined,
      atKey: promptAtOptionKey,
      setAtActive: popoverController.setAtActive,
      onAtSelect: popoverController.handleAtSelect,
      slashFlat: popoverController.slashFlat,
      slashActive: () => popoverController.slashActive() ?? undefined,
      setSlashActive: popoverController.setSlashActive,
      onSlashSelect: popoverController.handleSlashSelect,
    },
  }
}
