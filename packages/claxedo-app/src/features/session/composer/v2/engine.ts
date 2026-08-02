// The strangler seam (plan 2026-07-25-005, W3/T3.1).
//
// Exactly ONE engine is constructed per composer mount, so the two interaction
// state machines never coexist and cannot fight over the editor — the risk §6 of
// the plan flags as the highest in this migration. The DRAFT is deliberately not
// duplicated: both engines read and write the same per-scope persisted store
// (`providers/prompt.tsx`), which is what makes flipping the flag lossless.
import { createDocumentPickerController } from "@/features/session/composer/document-picker-controller"
import { createControllerComposerEngine } from "@/features/session/composer/v2/controller-engine"
import { createLegacyComposerEngine } from "@/features/session/composer/v2/legacy-engine"
import {
  composerEngineKind,
  type ComposerEngine,
  type ComposerEngineInput,
  type ComposerEngineKind,
} from "@/features/session/composer/v2/engine-contract"

export function createComposerEngine(input: ComposerEngineInput & { kind?: ComposerEngineKind }): ComposerEngine {
  // The document picker is engine-agnostic (it is a Claxedo surface on the `@`
  // list either way) but it calls back INTO the engine, so it is built here and
  // reaches the engine through late-bound thunks — the same knot the composer
  // used to tie with `let editorActions!`.
  let engine: ComposerEngine | undefined
  const documentPicker = createDocumentPickerController({
    directory: input.documentDirectory,
    list: input.listDocuments,
    mentionText: input.documentMentionText,
    replaceText: (text) => engine?.replaceText(text),
    openPopover: () => engine?.openContextSurface(),
  })
  const build = input.kind ?? composerEngineKind()
  engine =
    build === "controller"
      ? createControllerComposerEngine({ ...input, documentPicker })
      : createLegacyComposerEngine({ ...input, documentPicker })
  return engine
}
