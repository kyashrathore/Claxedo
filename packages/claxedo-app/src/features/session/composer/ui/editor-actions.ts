import { createSignal, type Accessor } from "solid-js"
import {
  createTextFragment,
  getCursorPosition,
  setCursorPosition,
  setRangeEdge,
} from "@/features/session/composer/ui/editor-dom"
import {
  createPromptPill,
  isNormalizedPromptEditor,
  parsePromptEditor,
  renderPromptEditor,
} from "@/features/session/composer/ui/editor-serialization"
import type { AtOption, SlashCommand } from "@/features/session/composer/ui/slash-popover"
import {
  DEFAULT_PROMPT,
  isPromptEqual,
  type ContentPart,
  type ImageAttachmentPart,
  type Prompt,
} from "@/features/session/providers/prompt"

const NON_EMPTY_TEXT = /[^\s\u200B]/

type PromptEditorActionsInput = {
  editor: Accessor<HTMLDivElement>
  prompt: {
    current(): Prompt
    cursor(): number | undefined
    dirty(): boolean
    set(prompt: Prompt, cursor?: number): void
  }
  imageAttachments: Accessor<ImageAttachmentPart[]>
  mode: Accessor<"normal" | "shell">
  setPopover: (popover: "at" | "slash" | null) => void
  resetHistoryNavigation: VoidFunction
  queueScroll: VoidFunction
  promptLength: (prompt: Prompt) => number
  atOnInput: (query: string) => void
  slashOnInput: (query: string) => void
  triggerSlashCommand: (id: string) => void
  openDocumentPicker: VoidFunction
  closeDocumentPicker: VoidFunction
  onDocumentSelect: (document: Extract<AtOption, { type: "document" }>) => void
}

export function createPromptEditorActions(input: PromptEditorActionsInput) {
  const mirror = { input: false }
  const [composing, setComposing] = createSignal(false)

  const closePopover = () => {
    input.setPopover(null)
    input.closeDocumentPicker()
  }

  /**
   * Open the `@`/`/` popover from outside the editor (the `+` menu's "Context" /
   * "Commands" entries). No trigger character is inserted: both lists populate
   * on an EMPTY query (`popover-controller.ts#promptAtOptions`), so priming the
   * filter to "" is all that stands between a menu click and a full list.
   *
   * `closeDocumentPicker()` first because the `@` list swaps to documents while
   * the picker is open, and a stale picker would show documents under a menu
   * entry that promises mentions.
   *
   * It deliberately does NOT move focus into the editor. Measured in the running
   * app: the caller is the `+` menu's teardown, and every focus attempt from
   * there — inline, on a frame, or on a macrotask — ended up blurred again by
   * Kobalte's focus scope, and `handleBlur` closes the popover, so the menu entry
   * looked inert. Leaving focus alone is what makes the surface actually stay
   * open; the rows are clickable, and typing/arrow keys take over as soon as the
   * user is in the editor.
   */
  const openPopover = (popover: "at" | "slash") => {
    input.closeDocumentPicker()
    if (popover === "at") input.atOnInput("")
    if (popover === "slash") input.slashOnInput("")
    input.setPopover(popover)
  }

  const clearEditor = () => {
    input.editor().innerHTML = ""
  }

  const setEditorText = (text: string) => {
    clearEditor()
    input.editor().textContent = text
  }

  const focusEditorEnd = () => {
    requestAnimationFrame(() => {
      const editor = input.editor()
      editor.focus()
      const range = document.createRange()
      const selection = window.getSelection()
      range.selectNodeContents(editor)
      range.collapse(false)
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
  }

  const currentCursor = () => {
    const editor = input.editor()
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || !editor.contains(selection.anchorNode)) return null
    return getCursorPosition(editor)
  }

  const renderEditorWithCursor = (parts: Prompt) => {
    const cursor = currentCursor()
    const editor = input.editor()
    renderPromptEditor(editor, parts)
    if (cursor !== null) setCursorPosition(editor, cursor)
  }

  const reconcile = (parts: Prompt) => {
    const editor = input.editor()
    if (mirror.input) {
      mirror.input = false
      if (isNormalizedPromptEditor(editor)) return

      renderEditorWithCursor(parts)
      return
    }

    const dom = parsePromptEditor(editor)
    if (isNormalizedPromptEditor(editor) && isPromptEqual(parts, dom)) return

    renderEditorWithCursor(parts)
  }

  const handleInput = () => {
    const editor = input.editor()
    const rawParts = parsePromptEditor(editor)
    const images = input.imageAttachments()
    const cursorPosition = getCursorPosition(editor)
    const rawText =
      rawParts.length === 1 && rawParts[0]?.type === "text"
        ? rawParts[0].content
        : rawParts.map((p) => ("content" in p ? p.content : "")).join("")
    const hasNonText = rawParts.some((part) => part.type !== "text")
    const shouldReset = !NON_EMPTY_TEXT.test(rawText) && !hasNonText && images.length === 0

    if (shouldReset) {
      closePopover()
      input.resetHistoryNavigation()
      if (input.prompt.dirty()) {
        mirror.input = true
        input.prompt.set(DEFAULT_PROMPT, 0)
      }
      input.queueScroll()
      return
    }

    if (input.mode() !== "shell") {
      const atMatch = rawText.substring(0, cursorPosition).match(/@(\S*)$/)
      const slashMatch = rawText.match(/^\/(\S*)$/)

      if (atMatch) {
        input.atOnInput(atMatch[1])
        input.setPopover("at")
      } else if (slashMatch) {
        input.slashOnInput(slashMatch[1])
        input.setPopover("slash")
      } else {
        closePopover()
      }
    } else {
      closePopover()
    }

    input.resetHistoryNavigation()

    mirror.input = true
    input.prompt.set([...rawParts, ...images], cursorPosition)
    input.queueScroll()
  }

  const addPart = (part: ContentPart) => {
    const editor = input.editor()
    if (part.type === "image") return false

    const selection = window.getSelection()
    if (!selection) return false

    if (selection.rangeCount === 0 || !editor.contains(selection.anchorNode)) {
      editor.focus()
      const cursor = input.prompt.cursor() ?? input.promptLength(input.prompt.current())
      setCursorPosition(editor, cursor)
    }

    if (selection.rangeCount === 0) return false
    const range = selection.getRangeAt(0)
    if (!editor.contains(range.startContainer)) return false

    if (part.type === "file" || part.type === "agent") {
      const cursorPosition = getCursorPosition(editor)
      const rawText = input.prompt
        .current()
        .map((p) => ("content" in p ? p.content : ""))
        .join("")
      const textBeforeCursor = rawText.substring(0, cursorPosition)
      const atMatch = textBeforeCursor.match(/@(\S*)$/)
      const pill = createPromptPill(part)
      const gap = document.createTextNode(" ")

      if (atMatch) {
        const start = atMatch.index ?? cursorPosition - atMatch[0].length
        setRangeEdge(editor, range, "start", start)
        setRangeEdge(editor, range, "end", cursorPosition)
      }

      range.deleteContents()
      range.insertNode(gap)
      range.insertNode(pill)
      range.setStartAfter(gap)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    if (part.type === "text") {
      const fragment = createTextFragment(part.content)
      const last = fragment.lastChild
      range.deleteContents()
      range.insertNode(fragment)
      if (last) {
        if (last.nodeType === Node.TEXT_NODE) {
          const text = last.textContent ?? ""
          if (text === "\u200B") {
            range.setStart(last, 0)
          }
          if (text !== "\u200B") {
            range.setStart(last, text.length)
          }
        }
        if (last.nodeType !== Node.TEXT_NODE) {
          const isBreak = last.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR"
          const next = last.nextSibling
          const emptyText = next?.nodeType === Node.TEXT_NODE && (next.textContent ?? "") === ""
          if (isBreak && (!next || emptyText)) {
            const placeholder = next && emptyText ? next : document.createTextNode("\u200B")
            if (!next) last.parentNode?.insertBefore(placeholder, null)
            placeholder.textContent = "\u200B"
            range.setStart(placeholder, 0)
          } else {
            range.setStartAfter(last)
          }
        }
      }
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    handleInput()
    closePopover()
    return true
  }

  const handleAtSelect = (option: AtOption | undefined) => {
    if (!option) return
    if (option.type === "document") {
      closePopover()
      input.onDocumentSelect(option)
      return
    }
    if (option.type === "agent") {
      addPart({ type: "agent", name: option.name, content: "@" + option.name, start: 0, end: 0 })
      return
    }
    addPart({ type: "file", path: option.path, content: "@" + option.path, start: 0, end: 0 })
  }

  const handleSlashSelect = (cmd: SlashCommand | undefined) => {
    if (!cmd) return
    if (cmd.id === "documents.open") {
      input.atOnInput("")
      input.openDocumentPicker()
      return
    }
    closePopover()

    if (cmd.type === "custom") {
      const text = `/${cmd.trigger} `
      setEditorText(text)
      input.prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      focusEditorEnd()
      return
    }

    clearEditor()
    input.prompt.set([{ type: "text", content: "", start: 0, end: 0 }], 0)
    input.triggerSlashCommand(cmd.id)
  }

  const handleBlur = () => {
    // Persist the caret into the prompt store so a later programmatic focus
    // (e.g. typing elsewhere on the page) can restore it — the DOM selection
    // does not survive editor re-renders while blurred.
    const cursor = currentCursor()
    if (cursor !== null && cursor !== input.prompt.cursor()) input.prompt.set(input.prompt.current(), cursor)
    closePopover()
    setComposing(false)
  }

  const handleCompositionStart = () => {
    setComposing(true)
  }

  const handleCompositionEnd = () => {
    setComposing(false)
    requestAnimationFrame(() => {
      if (composing()) return
      reconcile(input.prompt.current().filter((part) => part.type !== "image"))
    })
  }

  const isImeComposing = (event: KeyboardEvent) => event.isComposing || composing() || event.keyCode === 229

  return {
    addPart,
    closePopover,
    composing,
    handleAtSelect,
    handleBlur,
    handleCompositionEnd,
    handleCompositionStart,
    handleInput,
    handleSlashSelect,
    isImeComposing,
    openPopover,
    reconcile,
    replaceText(text: string) {
      setEditorText(text)
      input.prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      focusEditorEnd()
    },
  }
}
