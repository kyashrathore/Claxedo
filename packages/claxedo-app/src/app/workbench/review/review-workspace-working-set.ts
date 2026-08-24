import {
  CONTEXT_TAB_ID,
  REVIEW_TAB,
  REVIEW_TAB_ID,
  type ReviewWorkspaceTab,
} from "@/features/review/ui/review-workspace-tabs"
import type { ReviewMode } from "@/features/review/review-intent"
import {
  cloneReviewSurfaceState,
  type ReviewSurfaceState,
} from "@/features/review/review-surface-state"
import type { ReviewScrollPosition } from "./review-scroll-restoration"

export const MAX_REVIEW_WORKSPACE_WORKING_SETS = 32

export type ReviewWorkspaceWorkingSetIdentity = {
  /** Base URL of the Claxedo server the review data is read from. */
  serverUrl?: string
  /** Runtime workspace id for a relay-backed workspace; absent for a local one. */
  workspaceId?: string
  /** The panel's own `WorkspacePanelState.workspaceDir`, unchanged. */
  workspaceDir: string
  mode: ReviewMode
  fromRef?: string
  toRef?: string
}

/**
 * Trailing separators and surrounding whitespace never change which review a
 * caller means, so they must not split one working set across two keys. This is
 * identity normalization for the LRU only — URL building stays in the API layer.
 */
function normalizeIdentitySegment(value: string | undefined) {
  const trimmed = value?.trim()
  if (!trimmed) return ""
  return trimmed.replace(/(.)\/+$/, "$1")
}

/**
 * Identity of one retained Review working set: the runtime the review is read
 * from, the workspace, and the exact review target.
 *
 * Deliberately NOT keyed by session id. The panel's review is a property of the
 * workspace, so a session switch inside the same workspace must reopen the same
 * tabs and scroll instead of starting a second snapshot that immediately
 * evicts the first.
 */
export function reviewWorkspaceWorkingSetKey(identity: ReviewWorkspaceWorkingSetIdentity) {
  return [
    normalizeIdentitySegment(identity.serverUrl),
    normalizeIdentitySegment(identity.workspaceId),
    normalizeIdentitySegment(identity.workspaceDir),
    identity.mode,
    identity.fromRef ?? "",
    identity.toRef ?? "",
  ].join("\n")
}

/**
 * The Review surface's retained state plus the scroll position, which the
 * workspace owns rather than the Review surface (it is captured before a tab
 * insertion can clamp it — see `review-scroll-restoration`).
 */
export type ReviewWorkspaceReviewState = ReviewSurfaceState & {
  scroll: ReviewScrollPosition
}

export type ReviewWorkspaceWorkingSetSnapshot = {
  tabs: ReviewWorkspaceTab[]
  activeTabId: string
  review: ReviewWorkspaceReviewState
}

function cloneTab(tab: ReviewWorkspaceTab): ReviewWorkspaceTab {
  return { ...tab } as ReviewWorkspaceTab
}

function cloneScroll(position: ReviewScrollPosition): ReviewScrollPosition {
  return { ...position }
}

function cloneReview(review: ReviewWorkspaceReviewState): ReviewWorkspaceReviewState {
  return { ...cloneReviewSurfaceState(review), scroll: cloneScroll(review.scroll) }
}

export function cloneReviewWorkspaceWorkingSet(
  snapshot: ReviewWorkspaceWorkingSetSnapshot,
): ReviewWorkspaceWorkingSetSnapshot {
  return {
    tabs: snapshot.tabs.map(cloneTab),
    activeTabId: snapshot.activeTabId,
    review: cloneReview(snapshot.review),
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
  let review = cloneReview(initial.review)

  const publish = (tabs: readonly ReviewWorkspaceTab[], activeTabId: string) => {
    input.onChange?.(cloneReviewWorkspaceWorkingSet({
      tabs: tabs.map(cloneTab),
      activeTabId,
      review,
    }))
  }

  return {
    initial,
    /**
     * The live retained Review state: the latest published surface plus the
     * latest scroll. An inner-tab remount of the Review surface must restore
     * from this — `initial` is the panel-open snapshot, and restoring from it
     * would roll Review → file tab → Review back to panel-open state.
     */
    current(): ReviewWorkspaceReviewState {
      return cloneReview(review)
    },
    publish,
    publishScroll(
      position: ReviewScrollPosition,
      tabs: readonly ReviewWorkspaceTab[],
      activeTabId: string,
    ) {
      review = { ...review, scroll: cloneScroll(position) }
      publish(tabs, activeTabId)
    },
    /**
     * The Review surface owns its mode, refs, diff style, expansions, and
     * forced-large-diff paths; the scroll stays with the workspace.
     */
    publishSurface(
      surface: ReviewSurfaceState,
      tabs: readonly ReviewWorkspaceTab[],
      activeTabId: string,
    ) {
      review = { ...cloneReviewSurfaceState(surface), scroll: review.scroll }
      publish(tabs, activeTabId)
    },
  }
}
