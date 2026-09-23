import { createPanePreferences, reviewModePreferenceScope } from "@/features/review/app-ports"
import type { ReviewMode, ReviewSelection } from "@/features/session/preferences/pane"

export type { ReviewMode, ReviewSelection }

/** The modes measured from where HEAD left a base, which they carry as `fromRef`. */
export function isBaseReviewMode(mode: ReviewMode): mode is "branch" | "branch-worktree" {
  return mode === "branch" || mode === "branch-worktree"
}

export const reviewModeLabel: Record<ReviewMode, string> = {
  uncommitted: "Uncommitted",
  unstaged: "Unstaged",
  staged: "Staged",
  "to-from": "to / from",
  branch: "Branch changes",
  "branch-worktree": "Everything since base",
}

/** git's hash of the empty tree: the base a root commit is compared against. */
export const EMPTY_TREE_REF = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

const FULL_HASH = /^[0-9a-f]{40}$/

/** A full object hash reads as its seven-character abbreviation; any other ref reads as itself. */
export function shortRef(ref: string) {
  return FULL_HASH.test(ref) ? ref.slice(0, 7) : ref
}

/** The compare selection for one commit: its first parent (or the empty tree) against itself. */
export function commitReviewSelection(commit: { hash: string; parents: readonly string[] }): ReviewSelection {
  return { mode: "to-from", fromRef: commit.parents[0] ?? EMPTY_TREE_REF, toRef: commit.hash }
}

/**
 * The pane's review selection, read and written through the persisted pane
 * preference so the Review tab, its compare pill, and the Changes column agree.
 */
export function createReviewSelection(input: {
  scope: () => { directory?: string; sessionId?: string }
  fallback?: () => ReviewSelection | undefined
}) {
  const preferences = createPanePreferences(localStorage)
  return {
    selection: (): ReviewSelection => preferences.reviewSelection({ ...input.scope(), fallback: input.fallback?.() }),
    set: (selection: ReviewSelection) => {
      preferences.set("reviewMode", reviewModePreferenceScope(input.scope()), persistedReviewSelection(selection))
    },
  }
}

/**
 * The refs a selection's diff is asked for: both in `to-from`, the base in a
 * branch mode, none in a worktree mode. A worktree mode carries whatever refs
 * the pill last showed, and sending or persisting those would pin a
 * placeholder like `HEAD~1` over the default branch the next comparison
 * should start from.
 */
export function reviewDiffRefs(selection: ReviewSelection): { fromRef?: string; toRef?: string } {
  const fromRef = selection.fromRef?.trim() || undefined
  const toRef = selection.toRef?.trim() || undefined
  if (selection.mode === "to-from") {
    return { ...(fromRef === undefined ? {} : { fromRef }), ...(toRef === undefined ? {} : { toRef }) }
  }
  if (isBaseReviewMode(selection.mode) && fromRef !== undefined) return { fromRef }
  return {}
}

export function persistedReviewSelection(selection: ReviewSelection): ReviewSelection {
  return { mode: selection.mode, ...reviewDiffRefs(selection) }
}
