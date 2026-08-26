import { MAX_DIFF_CHANGED_LINES } from "../../src/features/review/ui/review-session-logic"
import {
  HEAVY_WORKSPACE_EXPANDED_DIFF_LINES,
  HEAVY_WORKSPACE_FILE_LINES,
} from "./heavy-workspace-reopen-contract"

/**
 * Contract for the `workspace-interactions` scenario: isolated interactions
 * inside an already-loaded workspace (data fetched, animations settled before
 * every clock starts). Sizes are derived from the heavy-workspace constants —
 * which themselves size against the app's own review/file rendering — so the
 * "large" fixtures scale WITH the baseline instead of drifting from it.
 */

// Two file tabs opened during the precondition (tab-switch material).
export const WORKSPACE_INTERACTIONS_PRELOADED_FILE_PATHS = [
  "src/generated/file-7.ts",
  "src/generated/file-113.ts",
] as const

// Opened (and then closed) as the measured open-file / close-file interactions.
export const WORKSPACE_INTERACTIONS_OPEN_FILE_PATH = "src/generated/file-419.ts"

// The large-file open target: an order of magnitude above the scenario's
// standard file weight, i.e. far above the median opened file.
export const WORKSPACE_INTERACTIONS_LARGE_FILE_PATH = "src/generated/file-42.ts"
export const WORKSPACE_INTERACTIONS_FILE_LINES = HEAVY_WORKSPACE_FILE_LINES
export const WORKSPACE_INTERACTIONS_LARGE_FILE_LINES = HEAVY_WORKSPACE_FILE_LINES * 10

// Diff weights. The fixture's generic rows carry (index % 9) + 1 additions
// (median 5), the measured expand target carries the heavy expanded-diff
// weight, and the large-diff target carries five times that — much larger
// than both the median row and the standard expand target.
export const WORKSPACE_INTERACTIONS_EXPAND_DIFF_INDEX = 0
export const WORKSPACE_INTERACTIONS_EXPAND_DIFF_LINES = HEAVY_WORKSPACE_EXPANDED_DIFF_LINES
export const WORKSPACE_INTERACTIONS_LARGE_DIFF_INDEX = 1
export const WORKSPACE_INTERACTIONS_LARGE_DIFF_LINES = HEAVY_WORKSPACE_EXPANDED_DIFF_LINES * 5

// The large diff's changed-line count (additions + deletions) deliberately
// EXCEEDS the app's render ceiling, so expanding it is measured as two
// isolated interactions: the large-diff guard pane appearing, then the
// explicit "render anyway" force that actually renders the hunks. The
// standard expand target stays under the ceiling and renders directly.
/**
 * How long the pointer rests on a review row's trigger before the measured
 * expand press. A mouse user reaches the row, stops, and then commits; the
 * driver's `page.mouse.click` collapses that to a single task, which charges
 * the click for work the app legitimately starts at hover time. 120ms is a
 * short, conservative dwell — well below the time a deliberate click takes end
 * to end — and it sits OUTSIDE the measured window, which arms at the trusted
 * pointerdown.
 */
export const WORKSPACE_INTERACTIONS_HOVER_DWELL_MS = 120

export const WORKSPACE_INTERACTIONS_LARGE_DIFF_CHANGED_LINES = WORKSPACE_INTERACTIONS_LARGE_DIFF_LINES * 2
export const WORKSPACE_INTERACTIONS_DIFF_RENDER_CEILING = MAX_DIFF_CHANGED_LINES

export type WorkspaceTabSnapshot = {
  openTabIds: string[]
  activeTabId?: string
}

/**
 * Tab navigation (Files<->Review, switching among open tabs) must change ONLY
 * the active tab: any change to the open-tab set means the interaction
 * mounted or destroyed surfaces it had no business touching.
 */
export function workspaceInteractionTabSwitchFailures(input: {
  interaction: string
  before: WorkspaceTabSnapshot
  after: WorkspaceTabSnapshot
  expectedActiveTabId?: string
}) {
  const failures: string[] = []
  if (!sameStrings(input.before.openTabIds, input.after.openTabIds)) {
    failures.push(
      `${input.interaction} changed the open tab set: ${JSON.stringify(input.before.openTabIds)} -> ${JSON.stringify(input.after.openTabIds)}`,
    )
  }
  if (input.expectedActiveTabId !== undefined && input.after.activeTabId !== input.expectedActiveTabId) {
    failures.push(
      `${input.interaction} activated ${String(input.after.activeTabId)}; expected ${input.expectedActiveTabId}`,
    )
  }
  return failures
}

/** Opening a file must add exactly one tab; closing it must remove exactly that tab. */
export function workspaceInteractionTabDeltaFailures(input: {
  interaction: string
  before: WorkspaceTabSnapshot
  after: WorkspaceTabSnapshot
  expectedDelta: 1 | -1
}) {
  const delta = input.after.openTabIds.length - input.before.openTabIds.length
  if (delta !== input.expectedDelta) {
    return [
      `${input.interaction} changed the tab count by ${delta}; expected ${input.expectedDelta} (${JSON.stringify(input.before.openTabIds)} -> ${JSON.stringify(input.after.openTabIds)})`,
    ]
  }
  return []
}

/**
 * The split/unified toggle must land on the expected style. Each direction is
 * its own isolated interaction, so both directions are gated separately.
 */
export function workspaceInteractionDiffStyleFailures(input: {
  interaction: string
  expectedStyle: string
  observedStyle?: string
}) {
  if (input.observedStyle !== input.expectedStyle) {
    return [
      `${input.interaction} landed on diff style ${String(input.observedStyle)}; expected ${input.expectedStyle}`,
    ]
  }
  return []
}

/**
 * Expanding a diff must add rendered hunks. The `data-review-rendered-hunks`
 * counter is the app's MONOTONIC render counter (it never decrements), so it
 * proves renders happened — it can never prove a collapse.
 */
export function workspaceInteractionExpandFailures(input: {
  interaction: string
  renderedHunksBefore: number
  renderedHunksAfter: number
}) {
  if (input.renderedHunksAfter <= input.renderedHunksBefore) {
    return [
      `${input.interaction} did not increase rendered hunks (${input.renderedHunksBefore} -> ${input.renderedHunksAfter})`,
    ]
  }
  return []
}

/**
 * Collapsing is proven structurally: collapsed rows mount no accordion
 * content at all (review-session.tsx wraps Content in Show when={expanded()}),
 * so the row's diff wrapper must be GONE and the trigger no longer expanded.
 */
export function workspaceInteractionCollapseFailures(input: {
  interaction: string
  stillExpanded: boolean
  contentMounted: boolean
}) {
  const failures: string[] = []
  if (input.stillExpanded) failures.push(`${input.interaction} left the diff trigger expanded`)
  if (input.contentMounted) {
    failures.push(`${input.interaction} left the collapsed row's diff content mounted; collapsed rows mount no content`)
  }
  return failures
}

/**
 * Expanding an above-ceiling diff must surface the app's large-diff guard
 * pane (not hunks); the follow-up force must then actually render hunks.
 */
export function workspaceInteractionLargeDiffGuardFailures(input: {
  interaction: string
  placeholderShown: boolean
}) {
  return input.placeholderShown
    ? []
    : [`${input.interaction} did not surface the large-diff guard pane for an above-ceiling diff`]
}

/**
 * Navigator mode change must land on the requested mode with its data ready.
 */
export function workspaceInteractionNavigatorFailures(input: {
  interaction: string
  expectedMode: "files" | "changes"
  observedMode?: string
  dataReady: boolean
}) {
  const failures: string[] = []
  if (input.observedMode !== input.expectedMode) {
    failures.push(
      `${input.interaction} landed on navigator mode ${String(input.observedMode)}; expected ${input.expectedMode}`,
    )
  }
  if (!input.dataReady) failures.push(`${input.interaction} navigator data never became ready`)
  return failures
}

// The resize drag moves the panel edge by this many pixels; the panel must
// actually track it (within half, since the panel clamps at min/max width).
export const WORKSPACE_INTERACTIONS_RESIZE_DELTA_PX = 160

export function workspaceInteractionResizeFailures(input: {
  widthBefore: number
  widthAfter: number
}) {
  const moved = Math.abs(input.widthAfter - input.widthBefore)
  if (moved < WORKSPACE_INTERACTIONS_RESIZE_DELTA_PX / 2) {
    return [
      `panel resize moved the shell ${moved}px; expected at least ${WORKSPACE_INTERACTIONS_RESIZE_DELTA_PX / 2}px of the ${WORKSPACE_INTERACTIONS_RESIZE_DELTA_PX}px drag`,
    ]
  }
  return []
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
