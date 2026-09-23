/**
 * What to do with a "show me this comment" request that cannot be satisfied yet.
 *
 * A comment can be asked for before the review surface mounts, and for a file
 * whose content has not been fetched — a summary row Pierre can position but has
 * no line geometry for. Both resolve on their own once the row becomes an
 * expanded diff, so the request is held and re-examined rather than retried on a
 * timer, and it is only cleared once it has actually been applied or has become
 * impossible.
 */
export type ReviewCommentFocusState = {
  /** The surface has published its reveal handles. */
  mounted: boolean
  /** The comment is still in the store. */
  commentExists: boolean
  /** The file is an expanded, loaded, unguarded diff: it has lines to jump to. */
  renderable: boolean
}

export type ReviewCommentFocusAction =
  /** Nothing to do until some input changes. */
  | "wait"
  /** Reach the row by item identity, so its content is requested. The surface
   *  applies a target it has already applied only once. */
  | "reveal-file"
  /** Jump to the comment's line and clear the request. */
  | "apply-line"
  /** The comment is gone; clear the request without moving. */
  | "drop"

export function reviewCommentFocusAction(state: ReviewCommentFocusState): ReviewCommentFocusAction {
  if (!state.mounted) return "wait"
  if (!state.commentExists) return "drop"
  return state.renderable ? "apply-line" : "reveal-file"
}
