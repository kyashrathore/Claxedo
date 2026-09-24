import { createEffect, createMemo, on, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import type { ContextItem, EditorMode, HistoryEntry, PromptPart } from "./model"
import { promptFilled, promptImages, promptText, randomId } from "./model"
import type { ComposerKey, ComposerStore } from "./store"
import { getCursorPosition, setCursorPosition } from "./editor/dom"
import { createEditorKeyDown, type PopoverKind } from "./editor/keymap"
import { parsePromptEditor, renderPromptEditor } from "./editor/serialization"
import { navigateHistory } from "./editor/history"
import type { AtItem, SlashItem, SuggestionQuery } from "./suggestions"

export type PopoverState =
  | { kind: "closed" }
  | { kind: "at"; query: string; start: number }
  | { kind: "slash"; query: string }

export type ComposerRefs = ReturnType<typeof createComposerRefs>

export function createComposerRefs() {
  const [refs, setRefs] = createStore<{
    editor?: HTMLDivElement
    root?: HTMLDivElement
    scroll?: HTMLDivElement
    fileInput?: HTMLInputElement
  }>({})
  return {
    editor: () => refs.editor,
    root: () => refs.root,
    scroll: () => refs.scroll,
    fileInput: () => refs.fileInput,
    setEditor: (element: HTMLDivElement) => setRefs("editor", element),
    setRoot: (element: HTMLDivElement) => setRefs("root", element),
    setScroll: (element: HTMLDivElement) => setRefs("scroll", element),
    setFileInput: (element: HTMLInputElement) => setRefs("fileInput", element),
  }
}

type ControllerInput = {
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

function atTrigger(text: string, cursor: number) {
  const before = text.slice(0, cursor)
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before)
  if (!match) return undefined
  return { query: match[1] ?? "", start: before.length - (match[1]?.length ?? 0) - 1 }
}

function slashTrigger(text: string) {
  const match = /^\/(\S*)$/.exec(text)
  return match ? { query: match[1] ?? "" } : undefined
}

export function createComposerController(input: ControllerInput) {
  const [state, setState] = createStore({
    mode: "normal" as EditorMode,
    popover: { kind: "closed" } as PopoverState,
    activeId: undefined as string | undefined,
    historyIndex: -1,
    savedPrompt: null as HistoryEntry | null,
    composing: false,
    focused: false,
  })
  let localInput = false

  const draft = () => input.store.draft(input.key())
  const text = createMemo(() => promptText(draft().prompt))
  const blank = createMemo(() => !promptFilled(draft()))
  const popoverKind = (): PopoverKind => (state.popover.kind === "closed" ? null : state.popover.kind)
  const suggestionQuery = createMemo((): SuggestionQuery => state.popover)
  const activeItems = () => (state.popover.kind === "at" ? input.atItems() : input.slashItems())

  const focusEditor = (cursor?: number) => {
    const editor = input.refs.editor()
    if (!editor) return
    editor.focus()
    setCursorPosition(editor, cursor ?? draft().cursor ?? text().length)
  }

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

  createEffect(() => {
    const items = activeItems()
    if (state.popover.kind === "closed") return
    if (state.activeId && items.some((item) => item.id === state.activeId)) return
    setState("activeId", items[0]?.id)
  })

  const updatePopover = (value: string, cursor: number) => {
    const at = state.mode === "normal" ? atTrigger(value, cursor) : undefined
    if (at) return setState("popover", { kind: "at", query: at.query, start: at.start })
    const slash = state.mode === "normal" ? slashTrigger(value) : undefined
    if (slash) return setState("popover", { kind: "slash", query: slash.query })
    setState("popover", { kind: "closed" })
  }

  const onInput = () => {
    const editor = input.refs.editor()
    if (!editor) return
    const parsed = parsePromptEditor(editor)
    const cursor = getCursorPosition(editor)
    localInput = true
    input.store.setPrompt(input.key(), [...parsed, ...promptImages(draft().prompt)], cursor)
    input.edited()
    updatePopover(promptText(parsed), cursor)
  }

  const closePopover = () => setState("popover", { kind: "closed" })

  const replaceSpan = (start: number, end: number, parts: PromptPart[]) => {
    const current = draft().prompt
    const images = promptImages(current)
    const value = text()
    const before = value.slice(0, start)
    const after = value.slice(end)
    const rebuilt: PromptPart[] = [
      ...(before ? [{ type: "text" as const, content: before, start: 0, end: 0 }] : []),
      ...parts,
      { type: "text" as const, content: after.startsWith(" ") ? after : ` ${after}`, start: 0, end: 0 },
      ...images,
    ]
    const cursor = start + parts.reduce((length, part) => length + ("content" in part ? part.content.length : 0), 0) + 1
    input.store.setPrompt(input.key(), rebuilt, cursor)
    closePopover()
    requestAnimationFrame(() => focusEditor(cursor))
  }

  const selectAt = (item: AtItem) => {
    if (state.popover.kind !== "at") return
    const start = state.popover.start
    const end = start + 1 + state.popover.query.length
    if (item.kind === "file") {
      return replaceSpan(start, end, [{ type: "file", path: item.path, content: `@${item.path}`, start: 0, end: 0 }])
    }
    const inserted = item.entry.insert()
    if ("text" in inserted) return replaceSpan(start, end, [{ type: "text", content: inserted.text, start: 0, end: 0 }])
    const context: ContextItem = {
      type: "text",
      key: `mention:${item.entry.id}:${randomId()}`,
      label: inserted.attachment.label,
      text: inserted.attachment.text,
    }
    input.store.addContext(input.key(), context)
    replaceSpan(start, end, [{ type: "text", content: `@${inserted.attachment.label}`, start: 0, end: 0 }])
  }

  const selectSlash = (item: SlashItem) => {
    closePopover()
    if (item.kind === "goal") return input.armGoal()
    input.store.setPrompt(input.key(), promptImages(draft().prompt), 0)
    input.runCommand(item)
  }

  const selectActive = () => {
    if (state.popover.kind === "closed") return
    const item = activeItems().find((candidate) => candidate.id === state.activeId)
    if (!item) return
    if (item.kind === "file" || item.kind === "mention") selectAt(item)
    else selectSlash(item)
  }

  const moveActive = (step: 1 | -1) => {
    const items = activeItems()
    if (items.length === 0 || state.popover.kind === "closed") return
    const index = items.findIndex((item) => item.id === state.activeId)
    const next = index < 0 ? (step === 1 ? 0 : items.length - 1) : (index + step + items.length) % items.length
    setState("activeId", items[next].id)
  }

  const popoverKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter") return selectActive()
    if (event.key === "ArrowDown" || event.key === "n") return moveActive(1)
    if (event.key === "ArrowUp" || event.key === "p") return moveActive(-1)
  }

  const applyHistory = (entry: HistoryEntry, cursor: "start" | "end") => {
    const position = cursor === "start" ? 0 : promptText(entry.prompt).length
    input.store.setPrompt(input.key(), entry.prompt, position)
    requestAnimationFrame(() => focusEditor(position))
  }

  const navigate = (direction: "up" | "down") => {
    const result = navigateHistory({
      direction,
      entries: input.store.history(input.key(), state.mode),
      historyIndex: state.historyIndex,
      currentPrompt: draft().prompt,
      currentComments: [],
      savedPrompt: state.savedPrompt,
    })
    setState({ historyIndex: result.historyIndex, savedPrompt: result.savedPrompt })
    if (result.handled) applyHistory(result.entry, result.cursor)
    return result.handled
  }

  const setMode = (mode: EditorMode) => {
    setState("mode", mode)
    closePopover()
  }

  const onKeyDown = createEditorKeyDown<KeyboardEvent>({
    editor: () => input.refs.editor() ?? document.body,
    mode: () => state.mode,
    setMode,
    popover: popoverKind,
    closePopover,
    pick: () => input.refs.fileInput()?.click(),
    getCaretState: () => {
      const editor = input.refs.editor()
      const selection = window.getSelection()
      return {
        collapsed: selection?.isCollapsed ?? true,
        cursorPosition: editor ? getCursorPosition(editor) : 0,
        textLength: text().length,
      }
    },
    isImeComposing: (event) => event.isComposing || state.composing,
    addTextPart: (content) => input.store.addPart(input.key(), { type: "text", content, start: 0, end: 0 }),
    selectPopoverActive: selectActive,
    atOnKeyDown: popoverKeyDown,
    slashOnKeyDown: popoverKeyDown,
    stoppable: input.working,
    abort: input.stop,
    escBlur: () => false,
    booting: () => false,
    working: input.working,
    blank,
    promptText: text,
    historyActive: () => state.historyIndex >= 0,
    navigateHistory: navigate,
    handleSubmit: () => input.submit(),
  })

  return {
    state,
    text,
    blank,
    suggestionQuery,
    activeItems,
    onInput,
    onKeyDown,
    onCursor: () => {
      const editor = input.refs.editor()
      if (editor && window.getSelection()?.isCollapsed) input.store.setCursor(input.key(), getCursorPosition(editor))
    },
    setComposing: (composing: boolean) => setState("composing", composing),
    setFocused: (focused: boolean) => setState("focused", focused),
    setActive: (id: string) => setState("activeId", id),
    selectAt,
    selectSlash,
    closePopover,
    setMode,
    openCommands: () => {
      input.store.setPrompt(input.key(), [{ type: "text", content: "/", start: 0, end: 1 }, ...promptImages(draft().prompt)], 1)
      setState("popover", { kind: "slash", query: "" })
      requestAnimationFrame(() => focusEditor(1))
    },
    openContext: () => {
      const value = text()
      const prefix = value && !value.endsWith(" ") ? `${value} @` : `${value}@`
      input.store.setPrompt(input.key(), [{ type: "text", content: prefix, start: 0, end: prefix.length }, ...promptImages(draft().prompt)], prefix.length)
      setState("popover", { kind: "at", query: "", start: prefix.length - 1 })
      requestAnimationFrame(() => focusEditor(prefix.length))
    },
    resetHistory: () => setState({ historyIndex: -1, savedPrompt: null }),
    focusEditor,
  }
}

export type ComposerController = ReturnType<typeof createComposerController>
