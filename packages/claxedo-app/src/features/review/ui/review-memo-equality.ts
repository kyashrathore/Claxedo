import type { SessionReviewComment } from "./review-session"

/**
 * Structural `equals` comparators for the review surface's memos.
 *
 * Both derivations mint a fresh collection on every recompute (a `Set` of
 * files, a filtered comment array), so reference equality would wake every
 * subscriber on each upstream tick. These compare the contents instead, which
 * is what decides whether the review window and its comment rows re-render.
 */

/** Two file sets (required, expanded) are the same when they name the same files. */
export function sameFileSet(a: ReadonlySet<string>, b: ReadonlySet<string>) {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const file of a) if (!b.has(file)) return false
  return true
}

/** Two comment lists are the same when they hold the same comments in order. */
export function sameComments(a: readonly SessionReviewComment[], b: readonly SessionReviewComment[]) {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false
  }
  return true
}
