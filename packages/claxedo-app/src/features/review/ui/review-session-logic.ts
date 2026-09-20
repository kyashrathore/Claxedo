import { checksum } from "@opencode-ai/ui/utils/encode"

// Pure decision helpers for the review surface: the oversized-diff gate and
// the trigger's DOM id.

/** Maximum changed lines before a diff is hidden behind a "render anyway" gate. */
export const MAX_DIFF_CHANGED_LINES = 500

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

/** Stable DOM id for a file's diff block (undefined for un-checksummable input). */
function diffId(file: string): string | undefined {
  const sum = checksum(file)
  if (!sum) return undefined
  return `session-review-diff-${sum}`
}

export function diffTriggerTestId(file: string): string | undefined {
  const id = diffId(file)
  if (!id) return undefined
  return `${id}-trigger`
}
