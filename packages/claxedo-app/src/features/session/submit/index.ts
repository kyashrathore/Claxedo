// Barrel for the prompt-submit phase modules. The entry orchestrator at
// components/prompt-input/submit.ts wires these together; everything
// else should reach into this directory by named import rather than by path
// into individual phase files.
export * from "./types"
export { setPromptSessionStatus } from "./pending"
export {
  clearPendingPrompt,
  clearPendingPromptsForTest,
  hasPendingPrompt,
  markPendingPromptSent,
  pendingPromptCount,
  registerPendingPrompt,
  takePendingPrompt,
  type PendingPrompt,
} from "../store/pending-prompt-registry"
export { isPageCommentPath, preparePromptRequest, createPromptTimelineReconciliation } from "./prepare-request"
export { dispatchPrompt } from "./dispatch"
export {
  resolveSubmitSessionTarget,
  resolveSubmitDirectory,
  resolveSubmitMode,
  resolveSubmittedConfig,
} from "./resolve"
export { waitForPendingWorktree, rollbackPromptDispatch, sendPromptRequest } from "./send"
export { applyCreatedSessionTargetEffects, applyOptimisticPromptHandoff } from "./handoff"
export { recordPromptSubmission } from "./post-submit"
export {
  createSessionWithLifecycle,
  type ClaxedoLifecycleListener,
  type ClaxedoLifecycleListenerEvent,
  type CreatedSessionTarget,
} from "./create-with-lifecycle"
