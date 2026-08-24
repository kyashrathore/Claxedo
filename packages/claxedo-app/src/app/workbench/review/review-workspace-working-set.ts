import {
  CONTEXT_TAB_ID,
  REVIEW_TAB,
  REVIEW_TAB_ID,
  type ReviewWorkspaceTab,
} from "@/features/review/ui/review-workspace-tabs"
import type { ReviewScrollPosition } from "./review-scroll-restoration"

export const MAX_REVIEW_WORKSPACE_WORKING_SETS = 32

export type ReviewWorkspaceWorkingSetSnapshot = {
  tabs: ReviewWorkspaceTab[]
  activeTabId: string
  review: {
    scroll: ReviewScrollPosition
  }
}

function cloneTab(tab: ReviewWorkspaceTab): ReviewWorkspaceTab {
  return { ...tab } as ReviewWorkspaceTab
}

function cloneScroll(position: ReviewScrollPosition): ReviewScrollPosition {
  return { ...position }
}

export function cloneReviewWorkspaceWorkingSet(
  snapshot: ReviewWorkspaceWorkingSetSnapshot,
): ReviewWorkspaceWorkingSetSnapshot {
  return {
    tabs: snapshot.tabs.map(cloneTab),
    activeTabId: snapshot.activeTabId,
    review: {
      scroll: cloneScroll(snapshot.review.scroll),
    },
  }
}

function defaultWorkingSet(contextSessionId?: string): ReviewWorkspaceWorkingSetSnapshot {
  const tabs: ReviewWorkspaceTab[] = [cloneTab(REVIEW_TAB)]
  if (contextSessionId) tabs.push({ id: CONTEXT_TAB_ID, kind: "context", sessionId: contextSessionId })
  return {
    tabs,
    activeTabId: contextSessionId ? CONTEXT_TAB_ID : REVIEW_TAB_ID,
    review: { scroll: { top: 0 } },
  }
}

/**
 * Provider-owned, non-reactive LRU for small UI working-set snapshots. Server
 * data and rendered DOM never enter this store; callers receive clones so a
 * Solid proxy or component mutation cannot escape into another mount.
 */
export function createReviewWorkspaceWorkingSetStore(
  maxEntries = MAX_REVIEW_WORKSPACE_WORKING_SETS,
) {
  const limit = Math.max(1, Math.floor(maxEntries))
  const snapshots = new Map<string, ReviewWorkspaceWorkingSetSnapshot>()

  const touch = (key: string, snapshot: ReviewWorkspaceWorkingSetSnapshot) => {
    snapshots.delete(key)
    snapshots.set(key, snapshot)
  }

  return {
    get(key: string) {
      const snapshot = snapshots.get(key)
      if (!snapshot) return
      touch(key, snapshot)
      return cloneReviewWorkspaceWorkingSet(snapshot)
    },
    set(key: string, snapshot: ReviewWorkspaceWorkingSetSnapshot) {
      touch(key, cloneReviewWorkspaceWorkingSet(snapshot))
      while (snapshots.size > limit) {
        const oldest = snapshots.keys().next().value
        if (oldest === undefined) break
        snapshots.delete(oldest)
      }
    },
    delete(key: string) {
      snapshots.delete(key)
    },
    size() {
      return snapshots.size
    },
  }
}

export type ReviewWorkspaceWorkingSetStore = ReturnType<typeof createReviewWorkspaceWorkingSetStore>

export function createReviewWorkspaceWorkingSetBoundary(input: {
  initial?: ReviewWorkspaceWorkingSetSnapshot
  fallbackContextSessionId?: string
  onChange?: (snapshot: ReviewWorkspaceWorkingSetSnapshot) => void
}) {
  const initial = input.initial
    ? cloneReviewWorkspaceWorkingSet(input.initial)
    : defaultWorkingSet(input.fallbackContextSessionId)
  let scroll = cloneScroll(initial.review.scroll)

  const publish = (tabs: readonly ReviewWorkspaceTab[], activeTabId: string) => {
    input.onChange?.(cloneReviewWorkspaceWorkingSet({
      tabs: tabs.map(cloneTab),
      activeTabId,
      review: { scroll },
    }))
  }

  return {
    initial,
    publish,
    publishScroll(
      position: ReviewScrollPosition,
      tabs: readonly ReviewWorkspaceTab[],
      activeTabId: string,
    ) {
      scroll = cloneScroll(position)
      publish(tabs, activeTabId)
    },
  }
}
