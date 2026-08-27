import {
  WORKSPACE_PANEL_CLOSE_GRACE_MS,
  WORKSPACE_PANEL_MOTION_MS,
} from "../../src/features/workspaces/ui/panel/workspace-panel-lifecycle"

/**
 * Contract for the `workspace-lifecycle` scenario: seven separately clocked
 * phases of the workspace panel's life, each an ISOLATED interaction with its
 * own trusted-pointerdown clock and settle gate. Timing constants are derived
 * from the app's own shipped motion constants so the harness can never drift
 * from the panel it measures.
 *
 * NOTE the app does not yet split the panel shell from its content (that
 * change is being built in parallel). Phase boundaries therefore use the
 * observables that exist TODAY; metric names for boundaries that are only
 * approximations of the future shell/content split are marked `approx` in the
 * driver's comments.
 */

// The shipped open/close transform motion and the exposure grace after close.
export const WORKSPACE_LIFECYCLE_MOTION_MS = WORKSPACE_PANEL_MOTION_MS
export const WORKSPACE_LIFECYCLE_CLOSE_GRACE_MS = WORKSPACE_PANEL_CLOSE_GRACE_MS

// Interruption phases click the opposite control a quarter of the way into
// the shipped motion. Derived from the motion so a re-tuned animation keeps
// the interruption inside it.
export const WORKSPACE_LIFECYCLE_INTERRUPT_DELAY_MS = Math.round(WORKSPACE_PANEL_MOTION_MS / 4)

// Post-close dwell before ownership is inspected: the close grace plus the
// same 160ms disposal margin the heavy-workspace contract uses, so a future
// lazy-unmount implementation has crossed its disposal boundary first.
export const WORKSPACE_LIFECYCLE_CLOSE_DWELL_MS = WORKSPACE_PANEL_CLOSE_GRACE_MS + 160

// The VCS changed-files fetch that the opening click must start. Matched
// against PerformanceResourceTiming entry names inside the opening window.
export const WORKSPACE_LIFECYCLE_DATA_FETCH_PATTERN = /\/diff\/vcs(?:\?|$)/

export type WorkspaceLifecycleColdOpenObservation = {
  completionMs: number
  acknowledgedMs?: number
  timedOut: boolean
  /** Approximate shell boundary: panel visible + geometry stable (no shell/content split yet). */
  shellSettledMs?: number
  /** Trusted click -> fetchStart of the first VCS changed-files request. */
  clickToFetchStartMs?: number
  /** fetchStart -> responseEnd of that request (phase 4: first data fetch). */
  fetchStartToDataMs?: number
  /** responseEnd -> above-fold review content rendered and interactive (phase 5). */
  dataToAboveFoldMs?: number
}

/**
 * Phase 1/4/5 gates. The fetch must exist and must have STARTED at the
 * opening click (a late fetch stays visible through the reported
 * click->fetch-start metric; only a fetch that never happened, data that
 * never arrived, or content that never rendered invalidates the run).
 */
export function workspaceLifecycleColdOpenFailures(observation: WorkspaceLifecycleColdOpenObservation) {
  const failures: string[] = []
  if (observation.shellSettledMs === undefined) {
    failures.push("workspace lifecycle cold open never reached a settled panel shell")
  }
  if (observation.clickToFetchStartMs === undefined) {
    failures.push("workspace lifecycle cold open never started its VCS changed-files fetch")
  } else if (observation.clickToFetchStartMs < 0) {
    failures.push(
      `workspace lifecycle cold open fetch started ${Math.abs(observation.clickToFetchStartMs)}ms BEFORE the opening click; the clock is invalid`,
    )
  }
  if (observation.clickToFetchStartMs !== undefined && observation.fetchStartToDataMs === undefined) {
    failures.push("workspace lifecycle cold open VCS data never arrived")
  }
  if (observation.dataToAboveFoldMs === undefined) {
    failures.push("workspace lifecycle cold open never rendered interactive above-fold review content")
  }
  return failures
}

export type WorkspaceLifecycleInterruptionObservation = {
  completionMs: number
  acknowledgedMs?: number
  timedOut: boolean
  /** ms between the (synthetic) initiating click and the trusted interrupting click. */
  interruptOffsetMs?: number
  /** the interrupted surface fully recovered (fully closed / fully open). */
  recovered: boolean
}

/**
 * Interruption phases are valid only when the interrupting click actually
 * landed INSIDE the shipped motion: after it, the run measured a plain
 * close/open, not a recovery, and must fail rather than mislabel itself.
 */
export function workspaceLifecycleInterruptionFailures(
  phase: string,
  observation: WorkspaceLifecycleInterruptionObservation,
) {
  const failures: string[] = []
  if (observation.interruptOffsetMs === undefined) {
    failures.push(`${phase} interruption offset was not observed`)
  } else if (observation.interruptOffsetMs <= 0 || observation.interruptOffsetMs >= WORKSPACE_LIFECYCLE_MOTION_MS) {
    failures.push(
      `${phase} interrupting click landed ${observation.interruptOffsetMs}ms after the initiating click, outside the ${WORKSPACE_LIFECYCLE_MOTION_MS}ms motion`,
    )
  }
  if (!observation.recovered) {
    failures.push(`${phase} did not recover to its target state`)
  }
  return failures
}

export type WorkspaceLifecycleWarmReopenObservation = {
  completionMs: number
  acknowledgedMs?: number
  timedOut: boolean
  /** Approximate shell boundary (no shell/content split yet). */
  shellSettledMs?: number
  /** Warm content (review rows from the already-fetched corpus) rendered. */
  contentReadyMs?: number
}

export function workspaceLifecycleWarmReopenFailures(observation: WorkspaceLifecycleWarmReopenObservation) {
  const failures: string[] = []
  if (observation.shellSettledMs === undefined) {
    failures.push("workspace lifecycle warm reopen never reached a settled panel shell")
  }
  if (observation.contentReadyMs === undefined) {
    failures.push("workspace lifecycle warm reopen never re-rendered its warm review content")
  }
  return failures
}

export type WorkspaceLifecycleAboveFoldSnapshot = {
  reviewFileRows: number
  totalFiles: number
  pending: boolean
}

/** Above-fold interactive means real rows from the full model, with no pending surface. */
export function workspaceLifecycleAboveFoldFailures(
  snapshot: WorkspaceLifecycleAboveFoldSnapshot,
  expectedTotal: number,
) {
  const failures: string[] = []
  if (snapshot.reviewFileRows === 0) failures.push("above-fold review rendered no file rows")
  if (snapshot.totalFiles !== expectedTotal) {
    failures.push(`above-fold review model held ${snapshot.totalFiles} files; expected ${expectedTotal}`)
  }
  if (snapshot.pending) failures.push("above-fold review still showed a pending surface")
  return failures
}
