import { createSignal, onCleanup } from "solid-js"

import {
  reviewVcsInvalidationFromEvent,
  type ReviewVcsEvent,
} from "@/features/review/ui/review-vcs-invalidation"

type RuntimeEvent = { details: ReviewVcsEvent }

/**
 * Tells a MOUNTED review when its data went stale, so it reloads immediately.
 *
 * This subscription belongs to the workspace rather than to the Review surface:
 * the surface unmounts whenever another workspace tab is active. The shared
 * query cache itself is kept honest by `WorkspaceVcsCacheHonesty` at directory
 * scope, which outlives the panel too; these versions only cover the surface
 * that is on screen right now.
 */
export function createReviewWorkspaceVcsStaleness(input: {
  listen: (handler: (event: RuntimeEvent) => void) => () => void
  sessionId: () => string
}) {
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
    if (invalidation.diffs) setDiffsVersion((version) => version + 1)
    if (invalidation.branch) setBranchVersion((version) => version + 1)
  }))

  return { branchVersion, diffsVersion }
}
