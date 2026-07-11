import { checksum } from "@opencode-ai/core/util/encode"

// Pure decision/derivation helpers for the session review surface (the one
// canonical review UI). Kept dependency-light so the diff-validation, comment
// grouping, expand/collapse, DOM-id, and oversized-diff-override rules can be
// tested without mounting the 700-line component.

/** Maximum changed lines before a diff is hidden behind a "render anyway" gate. */
export const MAX_DIFF_CHANGED_LINES = 500

export type ReviewDiffShape = {
  file: string
  additions: number
  deletions: number
  patch?: string
  before?: string
  after?: string
  status?: "added" | "deleted" | "modified"
}

/** Structural guard: is `value` a well-formed review diff record? */
export function isReviewDiff(value: unknown): value is ReviewDiffShape {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  if (!("file" in value) || typeof value.file !== "string") return false
  if (!("additions" in value) || typeof value.additions !== "number") return false
  if (!("deletions" in value) || typeof value.deletions !== "number") return false
  if ("patch" in value && value.patch !== undefined && typeof value.patch !== "string") return false
  if ("before" in value && value.before !== undefined && typeof value.before !== "string") return false
  if ("after" in value && value.after !== undefined && typeof value.after !== "string") return false
  if (!("status" in value) || value.status === undefined) return true
  return value.status === "added" || value.status === "deleted" || value.status === "modified"
}

/** Coerce an unknown payload (array, single diff, or keyed object) into a diff list. */
export function reviewDiffList(value: unknown): ReviewDiffShape[] {
  if (Array.isArray(value) && value.every(isReviewDiff)) return value
  if (Array.isArray(value)) return value.filter(isReviewDiff)
  if (isReviewDiff(value)) return [value]
  if (!value || typeof value !== "object") return []
  return Object.values(value).filter(isReviewDiff)
}

/** Does the diff carry renderable content (a patch or before/after text)? */
export function hasDiffContent(diff: ReviewDiffShape): boolean {
  return (
    typeof diff.patch === "string" ||
    ("before" in diff && typeof diff.before === "string") ||
    ("after" in diff && typeof diff.after === "string")
  )
}

/** Total changed lines for a diff. */
export function changedLineCount(diff: Pick<ReviewDiffShape, "additions" | "deletions">): number {
  return diff.additions + diff.deletions
}

/**
 * Whether a diff should be hidden behind the "render anyway" override. Only
 * expanded, non-media, not-yet-forced diffs above the changed-line ceiling are
 * gated — forcing (user clicked "render anyway") or a media file always renders.
 */
export function exceedsDiffLimit(input: {
  changedLines: number
  expanded: boolean
  forced: boolean
  media: boolean
  limit?: number
}): boolean {
  if (!input.expanded) return false
  if (input.forced) return false
  if (input.media) return false
  return input.changedLines > (input.limit ?? MAX_DIFF_CHANGED_LINES)
}

/** Toggle-all target: collapse everything if any file is open, else open all files. */
export function expandOrCollapseAll(open: string[], allFiles: string[]): string[] {
  return open.length > 0 ? [] : allFiles
}

/** Group comments by their file, preserving insertion order within each file. */
export function groupCommentsByFile<T extends { file: string }>(comments: readonly T[] | undefined): Map<string, T[]> {
  const next = new Map<string, T[]>()
  for (const comment of comments ?? []) {
    const list = next.get(comment.file)
    if (list) list.push(comment)
    else next.set(comment.file, [comment])
  }
  return next
}

/** Stable DOM id for a file's diff block (undefined for un-checksummable input). */
export function diffId(file: string): string | undefined {
  const sum = checksum(file)
  if (!sum) return
  return `session-review-diff-${sum}`
}

export function diffTestId(file: string): string | undefined {
  const id = diffId(file)
  if (!id) return
  return `${id}-item`
}

export function diffTriggerTestId(file: string): string | undefined {
  const id = diffId(file)
  if (!id) return
  return `${id}-trigger`
}
