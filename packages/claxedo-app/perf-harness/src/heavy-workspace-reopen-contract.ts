import {
  REVIEW_ESTIMATED_ROW_HEIGHT,
  reviewWindowRowBudget,
} from "../../src/features/review/ui/review-window"

export const HEAVY_WORKSPACE_REOPEN_FILE_PATHS = [
  "src/generated/file-7.ts",
  "src/generated/file-113.ts",
  "src/generated/file-419.ts",
] as const

// The first Review row is expanded before close. Make that body expensive
// enough to exercise diff parsing, row construction, syntax decoration, and
// layout rather than benchmarking a token one-line patch.
export const HEAVY_WORKSPACE_EXPANDED_DIFF_LINES = 240
export const HEAVY_WORKSPACE_FILE_LINES = 320
export const HEAVY_WORKSPACE_FILE_MIN_CHARS = 10_000

// Retained builds use the same workload as the future disposal build, but only
// the latter is allowed to claim zero hidden workspace ownership. Keeping this
// as an explicit run contract lets us record a valid retained baseline first
// and then fail the candidate if any closed or inactive subtree survives.
export const HEAVY_WORKSPACE_REQUIRE_DISPOSAL_ENV = "CLAXEDO_PERF_REQUIRE_WORKSPACE_DISPOSAL"

// The shipping panel's close motion is 120ms with a 20ms exposure grace. A
// 300ms dwell proves a future lazy-unmount implementation has crossed its
// disposal boundary before the reopen click, rather than measuring a reversal
// of the close animation.
export const HEAVY_WORKSPACE_CLOSE_DWELL_MS = 300

// The benchmark browser window height (the runner's viewport is 1440x960; a
// contract test pins the two against each other). The Review scroll viewport
// is strictly shorter than the window, so deriving the row budget from the
// full 960px is a sound upper bound on what the app may materialize.
export const HEAVY_WORKSPACE_VIEWPORT_HEIGHT = 960

// Mirrors REVIEW_MOUNT_MARGIN in review-session.tsx -- the overscan the app
// passes into the window.
export const HEAVY_WORKSPACE_REVIEW_OVERSCAN = 80

// The Review file list is windowed: at most this many viewport rows own DOM
// at once (required rows -- the scroll anchor, a focused file -- ride on
// top). The budget RULE is owned by the app's reviewWindowRowBudget
// (review-window.ts); the harness only supplies its benchmark geometry.
export const HEAVY_WORKSPACE_REVIEW_WINDOW_MAX_ROWS = reviewWindowRowBudget({
  viewportHeight: HEAVY_WORKSPACE_VIEWPORT_HEIGHT,
  overscan: HEAVY_WORKSPACE_REVIEW_OVERSCAN,
  estimatedRowHeight: REVIEW_ESTIMATED_ROW_HEIGHT,
})

// Required rows the window can add beyond the viewport cap (anchor + focus).
export const HEAVY_WORKSPACE_REVIEW_WINDOW_SLACK = 4

// ScrollView applies consumer attributes to its outer root; the element that
// owns scrollTop is the nested viewport marked data-scrollable.
export const HEAVY_WORKSPACE_REVIEW_SCROLL_SELECTOR =
  "[data-slot='session-review-scroll'] [data-scrollable]"

export type HeavyWorkspaceSurfaceIdentity = {
  openTabIds: string[]
  activeTabId?: string
  selectedFilePath?: string
  selectedFileChars?: number
  selectedFileLines?: number
  navigatorMode?: string
  reviewTabId?: string
}

export type HeavyWorkspaceReviewIdentity = {
  diffStyle?: string
  expandedPaths: string[]
  expandedBodyPaths: string[]
  reviewFileCount: number
  totalFileCount: number
  renderedHunks: number
  scrollTop: number
  scrollAnchorPath?: string
  scrollAnchorOffset?: number
}

export type HeavyWorkspaceScrollDiagnostic = {
  position: {
    top: number
    anchorPath?: string
    anchorOffset?: number
  }
}

/**
 * Opening a navigator or tab may give the restoration owner enough rendered
 * geometry to enrich a top-only observation with its semantic anchor. That is
 * not movement. Reject actual position loss while allowing only this one-way
 * enrichment to the expected deep anchor.
 */
export function heavyWorkspaceSetupScrollFailures(input: {
  before?: HeavyWorkspaceScrollDiagnostic
  after?: HeavyWorkspaceScrollDiagnostic
  expectedAnchorPath: string
  stage: string
}) {
  const { before, after, expectedAnchorPath, stage } = input
  if (!before || !after) return [`heavy workspace Review scroll diagnostic was unavailable ${stage}`]

  const failures: string[] = []
  if (Math.abs(before.position.top - after.position.top) > 0.5) {
    failures.push(
      `heavy workspace Review scroll moved ${stage}: ${before.position.top} -> ${after.position.top}`,
    )
  }
  if (before.position.anchorPath && before.position.anchorPath !== after.position.anchorPath) {
    failures.push(
      `heavy workspace Review scroll anchor changed ${stage}: ${before.position.anchorPath} -> ${String(after.position.anchorPath)}`,
    )
  }
  if (after.position.anchorPath !== expectedAnchorPath) {
    failures.push(
      `heavy workspace Review scroll anchor was ${String(after.position.anchorPath)} ${stage}; expected ${expectedAnchorPath}`,
    )
  }
  if (
    before.position.anchorOffset !== undefined &&
    (after.position.anchorOffset === undefined ||
      Math.abs(before.position.anchorOffset - after.position.anchorOffset) > 2)
  ) {
    failures.push(
      `heavy workspace Review scroll anchor offset changed ${stage}: ${before.position.anchorOffset} -> ${String(after.position.anchorOffset)}`,
    )
  }
  return failures
}

export type HeavyWorkspaceClosedOwnership = {
  shells: number
  tabs: number
  fileRoots: number
  navigators: number
  reviewRoots: number
  reviewFiles: number
}

export function heavyWorkspaceLiveFileFailures(identity: HeavyWorkspaceSurfaceIdentity) {
  const failures: string[] = []
  if (identity.selectedFileLines !== HEAVY_WORKSPACE_FILE_LINES) {
    failures.push(
      `active workspace file has ${String(identity.selectedFileLines)} lines; expected ${HEAVY_WORKSPACE_FILE_LINES}`,
    )
  }
  if ((identity.selectedFileChars ?? 0) < HEAVY_WORKSPACE_FILE_MIN_CHARS) {
    failures.push(
      `active workspace file has ${String(identity.selectedFileChars)} chars; expected at least ${HEAVY_WORKSPACE_FILE_MIN_CHARS}`,
    )
  }
  return failures
}

export function heavyWorkspaceClosedOwnershipFailures(ownership: HeavyWorkspaceClosedOwnership) {
  return Object.entries(ownership)
    .filter(([, count]) => count !== 0)
    .map(([name, count]) => `closed workspace retained ${count} ${name}; expected 0`)
}

/**
 * The windowed corpus contract: the model must hold every changed file while
 * the DOM holds only a window's worth of header rows -- but never zero.
 */
export function heavyWorkspaceWindowedCorpusFailures(input: {
  reviewFileCount: number
  totalFileCount: number
  expectedTotal: number
}) {
  const failures: string[] = []
  if (input.totalFileCount !== input.expectedTotal) {
    failures.push(`review model held ${input.totalFileCount} files; expected ${input.expectedTotal}`)
  }
  if (input.reviewFileCount === 0) {
    failures.push("review window materialized no file rows")
  }
  const cap = HEAVY_WORKSPACE_REVIEW_WINDOW_MAX_ROWS + HEAVY_WORKSPACE_REVIEW_WINDOW_SLACK
  if (input.reviewFileCount > cap) {
    failures.push(
      `review window materialized ${input.reviewFileCount} file rows; expected at most ${cap}`,
    )
  }
  return failures
}

export function heavyWorkspaceInactiveReviewOwnershipFailures(ownership: {
  roots: number
  files: number
  fileRoots: number
}) {
  const failures: string[] = []
  if (ownership.roots !== 0) failures.push(`active file retained ${ownership.roots} inactive Review roots; expected 0`)
  if (ownership.files !== 0) failures.push(`active file retained ${ownership.files} inactive Review files; expected 0`)
  if (ownership.fileRoots !== 1) failures.push(`active file mounted ${ownership.fileRoots} file roots; expected exactly 1`)
  return failures
}

export function heavyWorkspaceInactiveFileOwnershipFailures(ownership: { fileRoots: number }) {
  return ownership.fileRoots === 0
    ? []
    : [`active Review retained ${ownership.fileRoots} inactive file roots; expected 0`]
}

export function heavyWorkspaceRestorationFailures(
  before: HeavyWorkspaceSurfaceIdentity,
  after: HeavyWorkspaceSurfaceIdentity,
) {
  const failures: string[] = []
  if (!sameStrings(before.openTabIds, after.openTabIds)) {
    failures.push(
      `workspace tabs changed across close/reopen: ${JSON.stringify(before.openTabIds)} -> ${JSON.stringify(after.openTabIds)}`,
    )
  }
  if (before.activeTabId !== after.activeTabId) {
    failures.push(`active workspace tab changed across close/reopen: ${String(before.activeTabId)} -> ${String(after.activeTabId)}`)
  }
  if (before.selectedFilePath !== after.selectedFilePath) {
    failures.push(
      `workspace file selection changed across close/reopen: ${String(before.selectedFilePath)} -> ${String(after.selectedFilePath)}`,
    )
  }
  if (before.selectedFileChars !== after.selectedFileChars || before.selectedFileLines !== after.selectedFileLines) {
    failures.push(
      `workspace file content changed across close/reopen: ${String(before.selectedFileLines)} lines/${String(before.selectedFileChars)} chars -> ${String(after.selectedFileLines)} lines/${String(after.selectedFileChars)} chars`,
    )
  }
  if (before.navigatorMode !== after.navigatorMode) {
    failures.push(`workspace navigator changed across close/reopen: ${String(before.navigatorMode)} -> ${String(after.navigatorMode)}`)
  }
  if (before.reviewTabId !== after.reviewTabId) {
    failures.push(`review workspace tab changed across close/reopen: ${String(before.reviewTabId)} -> ${String(after.reviewTabId)}`)
  }
  return failures
}

/**
 * The panel reopens onto the previously active file. Review is intentionally
 * checked only after the user selects its tab: requiring its 500-file DOM in
 * the file-ready gate would reward mounting an inactive tab.
 */
export function heavyWorkspaceReviewRestorationFailures(
  before: HeavyWorkspaceReviewIdentity,
  after: HeavyWorkspaceReviewIdentity,
) {
  const failures: string[] = []
  if (before.diffStyle !== after.diffStyle) {
    failures.push(`review diff style changed across close/reopen: ${String(before.diffStyle)} -> ${String(after.diffStyle)}`)
  }
  if (!sameStrings(before.expandedPaths, after.expandedPaths)) {
    failures.push(
      `expanded review diffs changed across close/reopen: ${JSON.stringify(before.expandedPaths)} -> ${JSON.stringify(after.expandedPaths)}`,
    )
  }
  if (!sameStrings(before.expandedBodyPaths, after.expandedBodyPaths)) {
    failures.push(
      `rendered expanded review bodies changed across close/reopen: ${JSON.stringify(before.expandedBodyPaths)} -> ${JSON.stringify(after.expandedBodyPaths)}`,
    )
  }
  if (after.reviewFileCount !== before.reviewFileCount || after.totalFileCount !== before.totalFileCount) {
    failures.push(
      `review corpus changed after activation: ${before.reviewFileCount}/${before.totalFileCount} -> ${after.reviewFileCount}/${after.totalFileCount} rendered/total files`,
    )
  }
  // Hunk counters are only comparable when an expanded body is inside the
  // restored window; a windowed review scrolled away from its expanded rows
  // legitimately renders zero hunks on a fresh mount.
  if (before.expandedBodyPaths.length > 0 && after.renderedHunks < before.renderedHunks) {
    failures.push(`rendered review hunks regressed after activation: ${before.renderedHunks} -> ${after.renderedHunks}`)
  }
  if (before.scrollAnchorPath !== after.scrollAnchorPath) {
    failures.push(
      `review scroll anchor changed across close/reopen: ${String(before.scrollAnchorPath)} -> ${String(after.scrollAnchorPath)}`,
    )
  }
  if (
    before.scrollAnchorOffset === undefined ||
    after.scrollAnchorOffset === undefined ||
    Math.abs(before.scrollAnchorOffset - after.scrollAnchorOffset) > 2
  ) {
    failures.push(
      `review scroll anchor offset changed across close/reopen: ${String(before.scrollAnchorOffset)} -> ${String(after.scrollAnchorOffset)}`,
    )
  }
  if (before.scrollTop > 0 && after.scrollTop <= 0) {
    failures.push(`review deep scroll position was not restored: ${before.scrollTop} -> ${after.scrollTop}`)
  }
  return failures
}

/**
 * Expansion is semantic state, but the windowed list only shows it through
 * materialized rows: after the deep scroll the expanded row is unmounted, so
 * the before/after identities compared on resume both hold empty expansion
 * arrays and prove nothing. This gate takes the expansion captured while the
 * expanded rows were still mounted (before the deep scroll) and the expansion
 * re-read after resume with those rows scrolled back into the window. An empty
 * setup set is itself a failure, so the check can never pass vacuously.
 */
export function heavyWorkspaceExpansionRetentionFailures(input: {
  expandedAtSetup: readonly string[]
  expandedAfterResume: readonly string[]
}) {
  if (input.expandedAtSetup.length === 0) {
    return ["heavy workspace setup recorded no expanded review diff, so expansion restoration was never exercised"]
  }
  if (!sameStrings(input.expandedAtSetup, input.expandedAfterResume)) {
    return [
      `expanded review diffs were lost across close/reopen: ${JSON.stringify(input.expandedAtSetup)} -> ${JSON.stringify(input.expandedAfterResume)}`,
    ]
  }
  return []
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
