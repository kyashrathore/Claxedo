// Post-submit bookkeeping that runs once a prompt has been accepted
// (target session resolved, optimistic timeline updated). Pure
// orchestration — fires user callback, persists session config (best-
// effort), refreshes the directory's session list for replacement
// sessions, and records the analytics event.
//
// Moved out of `handoff.ts` on rubric Q2 so each module name accurately
// describes its contents (handoff = surface/handoff effects; post-submit
// = the after-acceptance bookkeeping that doesn't touch the Workbench).

import type { RecordPromptSubmissionContext } from "./types"

export async function recordPromptSubmission(input: RecordPromptSubmissionContext) {
  input.onSubmit?.()
  await input.saveSessionConfig()
  void input.refreshDirectory?.()
  input.capture()
}
