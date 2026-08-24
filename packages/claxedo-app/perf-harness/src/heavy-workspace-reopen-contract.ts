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

// The shipping panel's close motion is 120ms with a 20ms exposure grace. A
// 300ms dwell proves a future lazy-unmount implementation has crossed its
// disposal boundary before the reopen click, rather than measuring a reversal
// of the close animation.
export const HEAVY_WORKSPACE_CLOSE_DWELL_MS = 300

// ScrollView applies consumer attributes to its outer root; the element that
// owns scrollTop is the nested viewport marked data-scrollable.
export const HEAVY_WORKSPACE_REVIEW_SCROLL_SELECTOR =
  "[data-slot='session-review-scroll'] [data-scrollable]"

export type HeavyWorkspaceSurfaceIdentity = {
  openTabIds: string[]
  activeTabId?: string
  selectedFilePath?: string
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
  if (after.renderedHunks < before.renderedHunks) {
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

function sameStrings(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
