// The CONTROLLER engine: our frame driven by upstream's vendored
// `createPromptInputV2Controller` (plan 2026-07-25-005, Option 4 / W2-T2.2).
//
// ZERO upstream forks. This file is the whole adapter: it feeds the controller
// Claxedo's option lists as `PromptInputV2Suggestion`s, binds it to the per-scope
// draft tuple T2.1 exposed, and projects its state back into the popover/mode
// shape our frame already renders. Nothing under `packages/session-ui/` changed.
//
// What upstream now owns that our own machinery used to:
//   - the `@`/`/` popover state machine, including query derivation at the cursor
//   - suggestion filtering + active-row keyboard navigation
//   - shell-mode entry/exit
//   - prompt-history navigation (index + saved draft)
// What stays ours (and therefore keeps all eight §3 capabilities working):
//   - the contenteditable DOM (`v2/editor-bridge.ts` + `editor-serialization.ts`)
//   - submit, submit-block derivation, boot state, harness/model/permission rows
//   - attachments (so no `attachments` config is handed to the controller, which
//     is also why upstream's untyped `sourcePath` never enters our draft)
//   - document mentions (the picker stays a Claxedo surface on the `@` list)
import { batch, createEffect, createMemo, createSignal } from "solid-js"
import { createPromptInputV2Controller, type PromptInputV2Suggestion } from "@/ui/session-kit"
import { promptDraftControllerInput } from "@/features/session/providers/prompt"
import type { ContentPart } from "@/features/session/providers/prompt"
import {
  promptAgentOptions,
  promptAtOptionKey,
  promptDocumentOptions,
  promptSlashCommands,
} from "@/features/session/composer/ui/popover-controller"
import type { AtOption, SlashCommand } from "@/features/session/composer/ui/slash-popover"
import { moveBeforeZeroWidthSentinel } from "@/features/session/composer/ui/editor-keymap"
import { createPromptHistoryController } from "@/features/session/composer/ui/history-controller"
import { promptLength, type PromptHistoryComment } from "@/features/session/composer/ui/history"
import { createComposerEditorBridge } from "@/features/session/composer/v2/editor-bridge"
import {
  atOptionSuggestion,
  documentSelection,
  slashCommandSuggestion,
  suggestionAtOptions,
  suggestionDocumentId,
  suggestionSlashCommands,
} from "@/features/session/composer/v2/suggestions"
import type {
  ComposerEngine,
  ComposerEngineBuildInput,
  ComposerEngineDragging,
  ComposerEngineMode,
  ComposerEnginePopover,
} from "@/features/session/composer/v2/engine-contract"

const HISTORY_NAV_OWNED_BY_MACHINE = -1

export function createControllerComposerEngine(input: ComposerEngineBuildInput): ComposerEngine {
  const documentPicker = input.documentPicker
  const [dragging, setDragging] = createSignal<ComposerEngineDragging>(null)
  // Imperative one-shot, same as the legacy engine: nothing renders from it.
  let restoreEndOnFocus = true

  // History STORAGE + the comment round-trip stay here; navigation state
  // (index / saved draft) belongs to upstream's machine on this path, so the
  // index inputs are inert constants rather than a second source of truth.
  const history = createPromptHistoryController({
    comments: input.comments,
    prompt: input.prompt,
    mode: () => mode(),
    editor: input.editor,
    queueScroll: input.queueScroll,
    applyingHistory: () => false,
    setApplyingHistory: () => undefined,
    historyIndex: () => HISTORY_NAV_OWNED_BY_MACHINE,
    setHistoryIndex: () => undefined,
    savedPrompt: () => null,
    setSavedPrompt: () => undefined,
  })

  const agentOptions = createMemo(() => promptAgentOptions(input.agents()))
  const slashCommands = createMemo(() =>
    promptSlashCommands({ commandOptions: input.commandOptions(), customCommands: input.customCommands() }),
  )
  const contextOptions = createMemo<AtOption[]>(() => {
    if (documentPicker.open()) return promptDocumentOptions(documentPicker.documents())
    return [
      ...agentOptions(),
      ...input.recentFiles().map((path): AtOption => ({ type: "file", path, display: path, recent: true })),
    ]
  })

  const draft = promptDraftControllerInput(() => input.prompt.capture())

  const controller = createPromptInputV2Controller({
    store: draft.store,
    identity: draft.identity,
    history: {
      entries: (entryMode) =>
        history.entries(entryMode).map((entry) => ({ prompt: entry.prompt, metadata: entry.comments })),
      add: (prompt, entryMode) => history.addToHistory(prompt, entryMode),
      capture: () => history.historyComments(),
      restore: (metadata) => history.applyComments((metadata ?? []) as PromptHistoryComment[]),
    },
    commands: () => slashCommands().map(slashCommandSuggestion),
    context: () => contextOptions().map(atOptionSuggestion),
    searchContextFiles: async (query) =>
      (await input.searchFilesAndDirectories(query)).map((path) =>
        atOptionSuggestion({ type: "file", path, display: path }),
      ),
    onSuggestionSelect: (item) => onSuggestionSelect(item),
    view: {
      add: { onAttach: () => input.pick() },
      submit: {
        stopping: () => false,
        working: input.stoppable,
        onSubmit: () => undefined,
        onStop: () => input.abort(),
      },
      // The residual keymap: everything upstream's controller deliberately does
      // not decide. Reached only after the machine declined the key.
      onKeyDown: (event) => {
        if (event.key === "Enter" && event.shiftKey) {
          addPart({ type: "text", content: "\n", start: 0, end: 0 })
          event.preventDefault()
          return
        }
        if (event.key === "Escape" && input.escBlur()) {
          input.editor().blur()
          event.preventDefault()
        }
      },
    },
  })

  const state = controller.state
  /**
   * Every controller entry point that can WRITE the draft goes through a batch.
   * Reason, measured: `store.ts#addMention` writes `prompt` and then `cursor`
   * OUTSIDE a batch (unlike `setText`/`setPrompt`/`addText`, which batch), so an
   * unbatched mention insertion flushes our render effect once with the NEW parts
   * and the OLD cursor — the caret then lands before the trailing space upstream
   * just inserted, and the next keystroke produces "@reviewerplease" instead of
   * "@reviewer please" (core-composer-modes behavior 10 caught exactly this).
   * Batching makes each dispatch atomic to the DOM, which is what the editor
   * bridge's content comparison assumes. No upstream change needed.
   */
  const dispatch = (event: Parameters<typeof controller.dispatch>[0]) => batch(() => controller.dispatch(event))
  const mode = () => state.mode
  const popover = (): ComposerEnginePopover => {
    if (state.popover.type === "closed") return null
    return state.popover.type === "context" ? "at" : "slash"
  }
  const activeID = () => (state.popover.type === "closed" ? undefined : state.popover.activeID)

  const bridge = createComposerEditorBridge({
    editor: input.editor,
    parts: () => input.prompt.current(),
    cursor: () => input.prompt.cursor(),
    images: input.imageAttachments,
    onInput: (value, parts, cursor) => batch(() => controller.onInput(value, parts, cursor)),
    onCursor: (cursor) => controller.onCursor(cursor),
    // Upstream's own blur semantics (`machine.ts#focus.external` leaves the
    // popover alone). Keeping the popover open on blur is not incidental here:
    // it is what lets the `+` menu's Commands/Context entries stay non-inert,
    // since the menu's teardown blurs the editor right after it dispatches.
    onBlur: () => dispatch({ type: "focus.external" }),
    queueScroll: input.queueScroll,
  })

  const addPart = (part: ContentPart) => batch(() => controller.addPart(part))

  const closePopover = () => {
    dispatch({ type: "popover.close" })
    documentPicker.close()
  }

  const openPopover = (next: "at" | "slash") => {
    documentPicker.close()
    if (next === "at") batch(() => controller.openContext())
    if (next === "slash") batch(() => controller.openCommands())
  }

  const setMode = (next: ComposerEngineMode) => {
    if (next === "shell") batch(() => controller.openShell())
    if (next === "normal") batch(() => controller.closeShell())
  }

  const documentFor = (suggestion: PromptInputV2Suggestion) => {
    const documentId = suggestionDocumentId(suggestion)
    if (!documentId) return undefined
    return documentPicker.documents().find((entry) => entry.documentId === documentId)
  }

  /**
   * The three Claxedo selections upstream's machine cannot express. Returning a
   * thunk tells `interaction.ts#dispatch` "the host handles this one"; returning
   * undefined lets the machine's own draft write stand (which is exactly what a
   * CUSTOM slash command wants — it inserts `/trigger ` for further editing).
   */
  const onSuggestionSelect = (suggestion: PromptInputV2Suggestion) => {
    if (suggestion.kind === "resource") {
      const document = documentFor(suggestion)
      if (!document) return undefined
      return () => {
        closePopover()
        documentPicker.select(documentSelection(document))
      }
    }
    if (suggestion.kind !== "command") return undefined
    const command = slashCommands().find((entry) => entry.id === suggestion.id)
    if (!command) return undefined
    if (command.id === "documents.open") return () => documentPicker.show()
    if (command.type === "custom") return undefined
    return () => input.triggerSlashCommand(command.id)
  }

  let slashPopoverRef: HTMLDivElement | undefined
  createEffect(() => {
    const active = activeID()
    if (!active || popover() !== "slash" || !slashPopoverRef) return
    requestAnimationFrame(() => {
      slashPopoverRef?.querySelector(`[data-slash-id="${CSS.escape(active)}"]`)?.scrollIntoView({ block: "nearest" })
    })
  })

  const suggestions = () => controller.suggestions()

  return {
    kind: "controller",
    mode,
    setMode,
    enterMode: (next) => {
      setMode(next)
      if (next === "normal") dispatch({ type: "popover.close" })
      requestAnimationFrame(() => input.editor().focus())
    },
    popover,
    openPopover,
    openContextSurface: () => batch(() => controller.openContext()),
    closePopover,
    // Upstream's machine models drag as idle/active only, which would lose the
    // image-vs-@mention distinction the drop overlay's label depends on. Both are
    // written: the machine so its own state stays coherent, this signal so the
    // overlay keeps saying the right thing.
    draggingType: dragging,
    setDraggingType: (type) => {
      setDragging(type)
      dispatch({ type: type ? "drag.enter" : "drag.leave" })
    },
    addPart,
    replaceText: (text) => {
      closePopover()
      input.prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      bridge.focusEditorEnd()
    },
    bindEditor: (el) => {
      restoreEndOnFocus = true
      controller.setEditor(el)
    },
    handleFocus: () => {
      dispatch({ type: "focus.editor" })
      // Same one-shot caret restore the legacy path does: the persisted draft
      // cursor is the only record of where the user was before a remount.
      if (!restoreEndOnFocus) return
      restoreEndOnFocus = false
      requestAnimationFrame(() => {
        const editor = input.editor()
        if (document.activeElement !== editor) return
        bridge.placeCaret(input.prompt.cursor() ?? promptLength(input.prompt.current()))
        input.queueScroll()
      })
    },
    handleInput: bridge.handleInput,
    handleBlur: bridge.handleBlur,
    handleCompositionStart: bridge.handleCompositionStart,
    handleCompositionEnd: bridge.handleCompositionEnd,
    handleKeyDown: (event) => {
      if (event.key === "Backspace") moveBeforeZeroWidthSentinel()
      const hadPopover = popover() !== null
      const wasShell = mode() === "shell"
      if (batch(() => controller.onKeyDown(event))) {
        // Legacy stopped propagation for exactly these two so a global Escape
        // handler could not also fire; upstream only preventDefaults.
        if (event.key === "Escape" && (hadPopover || wasShell)) event.stopPropagation()
        return
      }
      if (event.key !== "Enter" || event.shiftKey || bridge.isImeComposing(event)) return
      event.preventDefault()
      if (event.repeat) return
      if (input.booting()) return
      if (input.working() && input.blank()) return
      input.handleSubmit(event)
    },
    addToHistory: (prompt, entryMode) => batch(() => controller.addHistory(prompt, entryMode)),
    resetHistoryNavigation: () => controller.resetHistory(),
    documentPicker,
    popoverView: {
      setSlashPopoverRef: (el) => {
        slashPopoverRef = el
      },
      atFlat: () => (popover() === "at" ? suggestionAtOptions(suggestions(), documentPicker.documents()) : []),
      atActive: () => (popover() === "at" ? activeID() : undefined),
      atKey: promptAtOptionKey,
      setAtActive: (id) => dispatch({ type: "popover.active", id }),
      onAtSelect: (item: AtOption) => dispatch({ type: "popover.select", item: atOptionSuggestion(item) }),
      slashFlat: () => (popover() === "slash" ? suggestionSlashCommands(suggestions(), slashCommands()) : []),
      slashActive: () => (popover() === "slash" ? activeID() : undefined),
      setSlashActive: (id) => dispatch({ type: "popover.active", id }),
      onSlashSelect: (item: SlashCommand) => dispatch({ type: "popover.select", item: slashCommandSuggestion(item) }),
    },
  }
}
