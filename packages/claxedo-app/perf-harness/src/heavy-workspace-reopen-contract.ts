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
  if (after.reviewFileCount < before.reviewFileCount) {
    failures.push(`review corpus regressed across close/reopen: ${before.reviewFileCount} -> ${after.reviewFileCount} rendered files`)
  }
  return failures
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
