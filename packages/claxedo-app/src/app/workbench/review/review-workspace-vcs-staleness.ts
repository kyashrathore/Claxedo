import { createSignal, onCleanup } from "solid-js"

import { invalidateReviewVcsDirectory } from "@/features/review/ui/review-vcs-cache"
import {
  reviewVcsInvalidationFromEvent,
  type ReviewVcsEvent,
} from "@/features/review/ui/review-vcs-invalidation"

type RuntimeEvent = { details: ReviewVcsEvent }

/**
 * Keeps one workspace's review data honest for as long as the workspace panel
 * is open.
 *
 * This subscription belongs to the workspace rather than to the Review surface:
 * the surface unmounts whenever another workspace tab is active, and a review
 * that stops watching restores stale diffs on its next mount. Dropping the
 * shared cache entries covers the unmounted case; the versions cover the
 * mounted one, so a review on screen reloads immediately.
 */
export function createReviewWorkspaceVcsStaleness(input: {
  listen: (handler: (event: RuntimeEvent) => void) => () => void
  directory: () => string
  sessionId: () => string
  invalidate?: typeof invalidateReviewVcsDirectory
}) {
  const invalidate = input.invalidate ?? invalidateReviewVcsDirectory
  const [diffsVersion, setDiffsVersion] = createSignal(0)
  const [branchVersion, setBranchVersion] = createSignal(0)
  let lastSessionStatusType: string | undefined

  onCleanup(input.listen((event) => {
    const invalidation = reviewVcsInvalidationFromEvent({
      event: event.details,
      sessionId: input.sessionId(),
      lastSessionStatusType,
    })
    if (invalidation.nextSessionStatusType !== undefined) {
      lastSessionStatusType = invalidation.nextSessionStatusType
    }
    if (!invalidation.diffs && !invalidation.branch) return
    invalidate({ directory: input.directory() })
    if (invalidation.diffs) setDiffsVersion((version) => version + 1)
    if (invalidation.branch) setBranchVersion((version) => version + 1)
  }))

  return { branchVersion, diffsVersion }
}
