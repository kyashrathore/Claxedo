export type WorkspaceRuntimeLog = {
  step: string
  message?: string
  ts: number
  totalMs?: number
}

/**
 * Append one startup step, collapsing an immediate repeat of the same row.
 *
 * Lives with the type it appends to rather than with the cloud provisioning
 * that produces most of the rows: it reads nothing but the list, and the
 * surfaces that render the list (`cloud-startup-view`, the composer's startup
 * handoff, the session actions dialog) all stay in `@claxedo/app` after the
 * hosted renderer is extracted. Filing it under `runtime/cloud` made three
 * local files import a hosted module for a pure array helper.
 *
 * Returns the SAME array when the step is a duplicate, so a Solid store write
 * of the result is a no-op rather than a re-render — `prepareUserHostedRuntime`
 * emits `checking_health` once per retry attempt.
 */
export function appendWorkspaceRuntimeLog(
  logs: WorkspaceRuntimeLog[],
  step: string,
  message?: string,
  totalMs?: number,
  now = Date.now(),
) {
  const prev = logs.at(-1)
  if (prev?.step === step && prev?.message === message) return logs
  return [...logs, { step, message, ts: now, totalMs }]
}
