import type { ReviewVcsDirectory } from "@/features/review/ui/review-vcs-cache"
import { REVIEW_TAB_ID, type ReviewWorkspaceTab } from "@/features/review/ui/review-workspace-tabs"
import { getClaxedoServerUrl } from "@/platform/api/api"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import {
  reviewWorkspaceWorkingSetKey,
  type ReviewWorkspaceWorkingSetStore,
} from "../review/review-workspace-working-set"

/** The only review target this panel mounts today; see `reviewWorkspaceKey`. */
export const PANEL_REVIEW_MODE = "uncommitted" as const

/**
 * Identity of the retained working set for this panel's review target — the
 * one key the body's load/store, the rail's click-time prefetch and the panel's
 * open policy resolve, so a warm-up and the mounted surface can never disagree
 * on the entry.
 */
export function panelReviewWorkingSetKey(input: ReviewVcsDirectory) {
  return reviewWorkspaceWorkingSetKey({
    serverUrl: getClaxedoServerUrl(),
    workspaceId: sessionWorkspaceRuntimeRef({ directory: input.directory })?.workspaceId,
    workspaceDir: input.directory,
    mode: PANEL_REVIEW_MODE,
  })
}

/**
 * The panel surface the user picked for this workspace, live or held across a
 * close. Review is excluded because it is the surface the panel falls back to,
 * so resting on it is indistinguishable from never having chosen one.
 */
export function workspacePanelChosenSurface(input: {
  reviewWorkingSet: Pick<ReviewWorkspaceWorkingSetStore, "get">
  workspaceDir: string | undefined
}): ReviewWorkspaceTab | undefined {
  if (!input.workspaceDir) return undefined
  const snapshot = input.reviewWorkingSet.get(panelReviewWorkingSetKey({ directory: input.workspaceDir }))
  if (!snapshot || snapshot.activeTabId === REVIEW_TAB_ID) return undefined
  return snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId)
}
