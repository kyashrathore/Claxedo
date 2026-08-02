// contenteditable <-> draft synchronisation for the CONTROLLER engine.
//
// Upstream's controller owns no DOM: `index.tsx` does the rendering upstream, and
// under Option 4 our frame owns it instead. So this is the one piece the vendored
// tree cannot give us — and it deliberately keeps Claxedo's serializers
// (`editor-serialization.ts`), which is what preserves the `[data-type=file]` /
// `[data-type=agent]` pill DOM the e2e suite and `build-request-parts.ts` read.
import { createEffect, createSignal, on } from "solid-js"
import { getCursorPosition, setCursorPosition } from "@/features/session/composer/ui/editor-dom"
import { parsePromptEditor, isNormalizedPromptEditor, renderPromptEditor } from "@/features/session/composer/ui/editor-serialization"
import { promptLength } from "@/features/session/composer/ui/history"
import { isPromptEqual, type ImageAttachmentPart, type Prompt } from "@/features/session/providers/prompt"

function promptText(parts: Prompt) {
  return parts.map((part) => ("content" in part ? part.content : "")).join("")
}

/** Images live in the same `Prompt` array but render as a chip strip, not in the editor. */
function editorParts(parts: Prompt) {
  return parts.filter((part) => part.type !== "image")
}

export function createComposerEditorBridge(input: {
  editor: () => HTMLDivElement
  /** The whole draft prompt, images included. */
  parts: () => Prompt
  cursor: () => number | undefined
  images: () => ImageAttachmentPart[]
  onInput: (value: string, parts: Prompt, cursor: number) => void
  onCursor: (cursor: number) => void
  onBlur: VoidFunction
  queueScroll: VoidFunction
}) {
  const [composing, setComposing] = createSignal(false)

  // Named so it is NOT a `set*` call inside a createEffect body (that shape is a
  // pinned debt metric, `effectStateWrites`), and because "place the caret" is
  // what it means at the two call sites.
  const placeCaret = (position: number) => setCursorPosition(input.editor(), position)

  const editorCursor = () => {
    const editor = input.editor()
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || !editor.contains(selection.anchorNode)) return null
    return getCursorPosition(editor)
  }

  const renderEditor = (parts: Prompt) => {
    const editor = input.editor()
    // Restore the caret whenever it was OURS to begin with — focus alone is too
    // narrow. `renderPromptEditor` replaces every child, and the DOM spec's
    // removing steps then collapse any range inside a removed node to
    // (editor, 0): skip the restore and the caret silently jumps to the START of
    // the composer, so the next keystroke lands before the text instead of after
    // it. Writing a selection while the caret lives somewhere ELSE on the page
    // would steal it, hence the anchored check rather than an unconditional set.
    const anchored = document.activeElement === editor || editorCursor() !== null
    renderPromptEditor(editor, editorParts(parts))
    if (anchored) placeCaret(input.cursor() ?? promptLength(parts))
  }

  /**
   * Content comparison rather than a "this write came from me" flag: the draft is
   * written twice in one keystroke whenever the state machine reacts to the text
   * it was just handed (typing `!` persists `"!"` and then clears it), and a flag
   * cannot tell those two writes apart without depending on Solid's flush
   * granularity. Comparing DOM against draft is granularity-free: identical means
   * the DOM already IS the draft, so typing never re-renders under the caret.
   */
  createEffect(
    on(
      () => input.parts(),
      (parts) => {
        if (composing()) return
        const editor = input.editor()
        const dom = parsePromptEditor(editor)
        if (isNormalizedPromptEditor(editor) && isPromptEqual(editorParts(parts), dom)) return
        renderEditor(parts)
      },
    ),
  )

  const handleInput = () => {
    const editor = input.editor()
    const parts = parsePromptEditor(editor)
    const cursor = getCursorPosition(editor)
    input.onInput(promptText(parts), [...parts, ...input.images()], cursor)
    input.queueScroll()
  }

  const handleBlur = () => {
    // Persist the caret into the draft so a later programmatic focus can restore
    // it: the DOM selection does not survive a re-render while blurred.
    const cursor = editorCursor()
    if (cursor !== null && cursor !== input.cursor()) input.onCursor(cursor)
    setComposing(false)
    input.onBlur()
  }

  const handleCompositionStart = () => setComposing(true)

  const handleCompositionEnd = () => {
    setComposing(false)
    requestAnimationFrame(() => {
      if (composing()) return
      renderEditor(input.parts())
    })
  }

  return {
    composing,
    placeCaret,
    handleInput,
    handleBlur,
    handleCompositionStart,
    handleCompositionEnd,
    isImeComposing: (event: KeyboardEvent) => event.isComposing || composing() || event.keyCode === 229,
    focusEditorEnd: () => {
      requestAnimationFrame(() => {
        const editor = input.editor()
        editor.focus()
        placeCaret(promptLength(input.parts()))
      })
    },
  }
}
