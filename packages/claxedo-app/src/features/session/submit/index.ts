// Barrel for the prompt-submit phase modules. The entry orchestrator at
// components/prompt-input/submit.ts wires these together; everything
// else should reach into this directory by named import rather than by path
// into individual phase files.
export * from "./types"
export {
  clearPendingPrompt,
  clearPendingPromptsForTest,
  hasPendingPrompt,
  pendingPromptCount,
  registerPendingPrompt,
  setPromptSessionStatus,
  takePendingPrompt,
  type PendingPrompt,
} from "./pending"
export { isPageCommentPath, preparePromptRequest, createPromptTimelineReconciliation } from "./prepare-request"
export { dispatchPrompt, dispatchShellCommand, dispatchSlashCommand } from "./dispatch"
export {
  resolveSubmitSessionTarget,
  resolveSubmitDirectory,
  resolveSubmitMode,
  resolveSubmittedConfig,
  resolvePromptDispatchClient,
} from "./resolve"
export { waitForPendingWorktree, rollbackPromptDispatch, sendPromptRequest } from "./send"
export { applyCreatedSessionTargetEffects, applyOptimisticPromptHandoff } from "./handoff"
export { recordPromptSubmission } from "./post-submit"
export {
  createOpencodeSessionWithLifecycle,
  type ClaxedoLifecycleListener,
  type ClaxedoLifecycleListenerEvent,
  type CreateOpencodeSessionTarget,
} from "./create-with-lifecycle"
