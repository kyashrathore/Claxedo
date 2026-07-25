// The one interface both composer input engines implement (plan 2026-07-25-005,
// W2/T2.2 + W3/T3.1). `composer.tsx` speaks ONLY this; it never sees
// `editor-actions.ts`/`popover-controller.ts` on one side or upstream's
// `createPromptInputV2Controller` on the other.
//
// Everything the eight Claxedo capabilities need (submit-block derivation,
// harness selection, workspace kinds, permission modes, document mentions,
// signed control plane, boot state, composer-mode scoping) stays OUTSIDE this
// contract, in our frame — which is exactly why Option 4 needs no upstream fork.
import type { Accessor } from "solid-js"
import type { ContentPart, ImageAttachmentPart, Prompt, usePrompt } from "@/features/session/providers/prompt"
import type { ComposerDocumentOption, createDocumentPickerController } from "@/features/session/composer/document-picker-controller"
import type { PromptHistoryComments } from "@/features/session/composer/ui/history-controller"
import type { AtOption, SlashCommand } from "@/features/session/composer/ui/slash-popover"

export type ComposerEngineMode = "normal" | "shell"
export type ComposerEnginePopover = "at" | "slash" | null
export type ComposerEngineDragging = "image" | "@mention" | null

export type ComposerEngineAgentRow = { name: string; hidden?: boolean; mode?: string }

export type ComposerEngineCommandOption = {
  id: string
  title: string
  description?: string
  keybind?: string
  slash?: string
  disabled?: boolean
}

export type ComposerEngineCustomCommand = {
  name: string
  description?: string
  source?: SlashCommand["source"]
}

/** The picker's own input contract, so the two can never disagree. */
type ComposerDocumentPickerInput = Parameters<typeof createDocumentPickerController>[0]

/** The document shape `document-picker-controller.ts#select` consumes. */
export type ComposerDocumentSelection = Omit<ComposerDocumentOption, "displayName"> & {
  type: "document"
  display: string
}

/** The popover projection our frame renders. Identical for both engines. */
export type ComposerEnginePopoverView = {
  setSlashPopoverRef: (el: HTMLDivElement) => void
  atFlat: Accessor<AtOption[]>
  atActive: Accessor<string | undefined>
  atKey: (item: AtOption) => string
  setAtActive: (id: string) => void
  onAtSelect: (item: AtOption) => void
  slashFlat: Accessor<SlashCommand[]>
  slashActive: Accessor<string | undefined>
  setSlashActive: (id: string) => void
  onSlashSelect: (item: SlashCommand) => void
}

export type ComposerEngineDocumentPicker = {
  open: Accessor<boolean>
  notice: Accessor<string | undefined>
  documents: Accessor<ComposerDocumentOption[]>
}

export type ComposerEngine = {
  /** Which engine actually got built. Reported so tests can assert the flip. */
  kind: ComposerEngineKind
  mode: Accessor<ComposerEngineMode>
  /** Programmatic mode write (submit clear/restore, edit loader): no focus move. */
  setMode: (mode: ComposerEngineMode) => void
  /** User-initiated mode change (`+` menu, mode commands): closes the popover and refocuses. */
  enterMode: (mode: ComposerEngineMode) => void
  popover: Accessor<ComposerEnginePopover>
  openPopover: (popover: "at" | "slash") => void
  /**
   * Open the `@` surface WITHOUT closing the document picker. The picker calls
   * this from its own `show()`, so routing it through `openPopover` (which closes
   * the picker, because the `+` menu's Context entry must never show documents
   * under a "Context" label) would close the picker it was just opening.
   */
  openContextSurface: VoidFunction
  closePopover: VoidFunction
  draggingType: Accessor<ComposerEngineDragging>
  setDraggingType: (type: ComposerEngineDragging) => void
  addPart: (part: ContentPart) => boolean
  replaceText: (text: string) => void
  bindEditor: (el: HTMLDivElement) => void
  handleFocus: VoidFunction
  handleInput: VoidFunction
  handleBlur: VoidFunction
  handleCompositionStart: VoidFunction
  handleCompositionEnd: VoidFunction
  handleKeyDown: (event: KeyboardEvent) => void
  addToHistory: (prompt: Prompt, mode: ComposerEngineMode) => void
  resetHistoryNavigation: (force?: boolean) => void
  documentPicker: ComposerEngineDocumentPicker
  popoverView: ComposerEnginePopoverView
}

/**
 * Everything an engine needs from the composer. Late-bound as thunks wherever
 * the composer only defines the value after the engine exists (`abort` and
 * `handleSubmit` come out of `createPromptSubmit`, which needs `engine.mode`).
 */
export type ComposerEngineInput = {
  editor: () => HTMLDivElement
  prompt: ReturnType<typeof usePrompt>
  imageAttachments: Accessor<ImageAttachmentPart[]>
  queueScroll: VoidFunction
  comments: PromptHistoryComments
  agents: Accessor<ComposerEngineAgentRow[]>
  recentFiles: Accessor<string[]>
  searchFilesAndDirectories: (query: string) => Promise<string[]>
  commandOptions: Accessor<ComposerEngineCommandOption[]>
  customCommands: Accessor<ComposerEngineCustomCommand[] | undefined>
  triggerSlashCommand: (id: string) => void
  documentDirectory: ComposerDocumentPickerInput["directory"]
  listDocuments: ComposerDocumentPickerInput["list"]
  documentMentionText: ComposerDocumentPickerInput["mentionText"]
  pick: VoidFunction
  escBlur: () => boolean
  stoppable: Accessor<boolean>
  booting: Accessor<boolean>
  working: Accessor<boolean>
  blank: Accessor<boolean>
  abort: VoidFunction
  handleSubmit: (event: KeyboardEvent) => void
}

/** What `v2/engine.ts` hands each engine on top of the composer's own input. */
export type ComposerEngineBuildInput = ComposerEngineInput & {
  documentPicker: ComposerEngineDocumentPicker & {
    show: VoidFunction
    close: VoidFunction
    select: (document: ComposerDocumentSelection) => void
  }
}

// ---------------------------------------------------------------------------
// The flag that picks the implementation.
// ---------------------------------------------------------------------------
// Strangler switch for the composer's INPUT ENGINE (plan 2026-07-25-005, W3/T3.1).
//
// Two engines drive the exact same Claxedo frame:
//   "legacy"     — our own `editor-actions.ts` + `popover-controller.ts` + the
//                  local popover/history machinery. THE DEFAULT.
//   "controller" — upstream's vendored `createPromptInputV2Controller`.
//
// Only ONE is constructed per composer mount (`v2/engine.ts`), so the two
// interaction state machines never coexist. The persisted DRAFT is deliberately
// the single source of truth for both (`providers/prompt.tsx`) — that is what
// makes flipping the flag lossless: the draft is not owned by either engine.
export type ComposerEngineKind = "legacy" | "controller"

/**
 * Per-browser override, read once per composer mount. Set it from the devtools
 * console (`localStorage.setItem("claxedo.composer.engine", "controller")`) and
 * reload; e2e sets `VITE_CLAXEDO_COMPOSER_ENGINE` on the dev server instead.
 */
export const COMPOSER_ENGINE_STORAGE_KEY = "claxedo.composer.engine"

/** `v2`/`v1` are accepted spellings so the plan's own vocabulary works verbatim. */
export function normalizeComposerEngineKind(value: string | null | undefined): ComposerEngineKind | undefined {
  if (value === "controller" || value === "v2") return "controller"
  if (value === "legacy" || value === "v1") return "legacy"
  return undefined
}

/** Pure resolution order: explicit per-browser override, then build env, then legacy. */
export function resolveComposerEngineKind(input: {
  stored?: string | null
  env?: string | null
}): ComposerEngineKind {
  return normalizeComposerEngineKind(input.stored) ?? normalizeComposerEngineKind(input.env) ?? "legacy"
}

function storedComposerEngineKind() {
  if (typeof window === "undefined") return undefined
  try {
    return window.localStorage.getItem(COMPOSER_ENGINE_STORAGE_KEY)
  } catch {
    // Private-mode / blocked storage: fall through to the build-time value.
    return undefined
  }
}

export function composerEngineKind(): ComposerEngineKind {
  return resolveComposerEngineKind({
    stored: storedComposerEngineKind(),
    env: import.meta.env.VITE_CLAXEDO_COMPOSER_ENGINE,
  })
}
