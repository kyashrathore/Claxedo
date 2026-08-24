import type { ReviewMode } from "./review-intent"

export type ReviewDiffStyle = "unified" | "split"

/**
 * Everything the Review surface must come back on after its DOM is disposed,
 * and nothing else.
 *
 * Deliberately excluded: VCS and file payloads, hunks, loading flags, the
 * mounted/loaded file ids, timers, and DOM. Those are derived from the
 * canonical producer on the next mount — retaining them would both stale the
 * surface and hold the memory a closed Workspace is supposed to give back.
 */
export type ReviewSurfaceState = {
  mode?: ReviewMode
  fromRef?: string
  toRef?: string
  diffStyle?: ReviewDiffStyle
  /** Expanded diff rows, by path. */
  openDiffs?: string[]
  focusedFile?: string
  /** Paths the user chose to render past the large-diff limit. */
  forcedDiffPaths?: string[]
  /**
   * How many file rows the progressive renderer had admitted. A number, not
   * DOM: restoring it lets a remounted review rebuild the corpus the user had
   * on screen in one pass instead of re-admitting rows two per idle callback,
   * which cannot reach a deep scroll anchor within any reasonable budget.
   */
  renderedFileLimit?: number
}

export function cloneReviewSurfaceState(state: ReviewSurfaceState): ReviewSurfaceState {
  return {
    ...state,
    ...(state.openDiffs ? { openDiffs: [...state.openDiffs] } : {}),
    ...(state.forcedDiffPaths ? { forcedDiffPaths: [...state.forcedDiffPaths] } : {}),
  }
}

/**
 * The expanded rows a freshly loaded changeset should open with.
 *
 * A remount reloads the changeset from the canonical producer, so a retained
 * expansion is only honored for paths that are still in it — a file that has
 * since been committed or reverted must not reappear as an expanded row. With
 * nothing retained (or nothing left of it), this is the existing behavior:
 * only the focused file opens.
 */
export function restoredOpenDiffs(input: {
  files: readonly string[]
  retained?: readonly string[]
  focused?: string
}) {
  const live = new Set(input.files)
  const retained = (input.retained ?? []).filter((path) => live.has(path))
  if (retained.length === 0) return input.focused ? [input.focused] : []
  if (input.focused && live.has(input.focused) && !retained.includes(input.focused)) {
    return [...retained, input.focused]
  }
  return retained
}
