// Centralized upstream session-ui imports. App code imports this file so an
// upstream package reshuffle is localized to one boundary.
export * from "@opencode-ai/session-ui/basic-tool"
export * from "@opencode-ai/session-ui/context"
export * from "@opencode-ai/session-ui/dock-prompt"
export * from "@opencode-ai/session-ui/file"
export * from "@opencode-ai/session-ui/format-duration"
export * from "@opencode-ai/session-ui/line-comment"
export * from "@opencode-ai/session-ui/line-comment-annotations"
export * from "@opencode-ai/session-ui/markdown"
export * from "@opencode-ai/session-ui/message-part"
export * from "@opencode-ai/session-ui/subagent-chip"
export * from "@opencode-ai/session-ui/pierre/media"
export * from "@opencode-ai/session-ui/pierre/selection-bridge"
export * from "@opencode-ai/session-ui/session-diff"
export * from "@opencode-ai/session-ui/session-retry"
export * from "@opencode-ai/session-ui/session-turn"
// v2 prompt-input view model (plan 2026-07-25-005 / T2.1). TYPE-ONLY on purpose:
// the barrel stays free of v2 runtime code, while app code that must speak the
// vendored engine's persisted-state shape still crosses exactly one boundary.
export type { PromptInputV2StoreInput, PromptInputV2StoreTuple } from "@opencode-ai/session-ui/v2/prompt-input/store"
export type {
  PromptInputV2HistoryEntry,
  PromptInputV2PersistedState,
  PromptInputV2Prompt,
  PromptInputV2Suggestion,
} from "@opencode-ai/session-ui/v2/prompt-input/types"
// T2.2 needs the engine at RUNTIME, not just its types, and the boundary scanner
// (`architecture/scanners.ts#deepSessionUiImportMetric`) exempts only this file —
// so the controller factory is re-exported here by name. Named, not `export *`:
// the barrel must not start pulling upstream's v2 SHELL markup (`index.tsx`) into
// every bundle that imports session-kit. `interaction.ts` + its `machine.ts` /
// `store.ts` / `attachments.ts` deps are pure logic.
export { createPromptInputV2Controller } from "@opencode-ai/session-ui/v2/prompt-input/interaction"
export type { PromptInputV2Interaction } from "@opencode-ai/session-ui/v2/prompt-input/interaction"
