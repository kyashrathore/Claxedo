export const HEAVY_WORKSPACE_REOPEN_FILE_PATHS = [
  "src/generated/file-7.ts",
  "src/generated/file-113.ts",
  "src/generated/file-419.ts",
] as const

// The shipping panel's close motion is 120ms with a 20ms exposure grace. A
// 300ms dwell proves a future lazy-unmount implementation has crossed its
// disposal boundary before the reopen click, rather than measuring a reversal
// of the close animation.
export const HEAVY_WORKSPACE_CLOSE_DWELL_MS = 300

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
  reviewFileCount: number
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
  if (after.reviewFileCount < before.reviewFileCount) {
    failures.push(`review corpus regressed after activation: ${before.reviewFileCount} -> ${after.reviewFileCount} rendered files`)
  }
  return failures
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
