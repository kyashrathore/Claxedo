/**
 * Hide hysteresis for the timeline Thinking row.
 *
 * Status can blip idle→busy (or settled→unsettled) for a few frames while a
 * stream is still running. Dropping the row immediately collapses the
 * virtualizer and jumps the composer. Show Thinking as soon as it is wanted;
 * keep it painted for a short hold after whatever clears it.
 */
export const THINKING_HIDE_HOLD_MS = 80

export type ThinkingVisibilityHold = {
  visible: boolean
  /** Epoch-ms deadline while a hide is being held; cleared once the row may drop. */
  heldUntilMs: number | undefined
}

export function nextThinkingVisibilityHold(input: {
  want: boolean
  heldUntilMs: number | undefined
  nowMs: number
  hideHoldMs?: number
}): ThinkingVisibilityHold {
  const holdMs = input.hideHoldMs ?? THINKING_HIDE_HOLD_MS
  if (input.want) return { visible: true, heldUntilMs: undefined }

  if (input.heldUntilMs === undefined) {
    return { visible: true, heldUntilMs: input.nowMs + Math.max(0, holdMs) }
  }
  if (input.nowMs < input.heldUntilMs) {
    return { visible: true, heldUntilMs: input.heldUntilMs }
  }
  return { visible: false, heldUntilMs: undefined }
}
