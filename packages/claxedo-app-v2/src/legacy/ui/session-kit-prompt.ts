// The LIGHT upstream boundary for the vendored v2 prompt-input engine.
//
// The composer is deliberately eager (SessionContent must not bubble a
// top-level Suspense fallback — see first-party-content-surfaces.tsx), and its
// controller engine needs upstream's `createPromptInputV2Controller` at
// runtime. That engine is pure logic (`interaction.ts` + `machine.ts` /
// `store.ts` / `attachments.ts` — no render components). Importing it through
// `./session-kit.ts` would drag that barrel's `export *` lines — File,
// Markdown, MessagePart, session-diff — whose bodies statically pull
// @pierre/diffs + shiki (~97 KB gz) into the eager main chunk.
//
// So the eager composer imports THIS file, and `session-kit.ts` re-exports it
// so every lazy consumer keeps its single `@/ui/session-kit` import path.
// Like `session-kit.ts`, this file is exempted by name in
// `architecture/scanners.ts#deepSessionUiImportMetric`.
export { createPromptInputV2Controller } from "@opencode-ai/session-ui/v2/prompt-input/interaction"
export type { PromptInputV2Interaction } from "@opencode-ai/session-ui/v2/prompt-input/interaction"
export type { PromptInputV2StoreInput, PromptInputV2StoreTuple } from "@opencode-ai/session-ui/v2/prompt-input/store"
export type {
  PromptInputV2HistoryEntry,
  PromptInputV2PersistedState,
  PromptInputV2Prompt,
  PromptInputV2Suggestion,
} from "@opencode-ai/session-ui/v2/prompt-input/types"
