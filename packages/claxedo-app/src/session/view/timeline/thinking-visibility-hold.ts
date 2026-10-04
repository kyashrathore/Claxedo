export const THINKING_HIDE_HOLD_MS = 80

export type ThinkingVisibilityHold = {
  visible: boolean
  heldUntilMs: number | undefined
}

export function nextThinkingVisibilityHold(input: {
  want: boolean
  blocked?: boolean
  heldUntilMs: number | undefined
  nowMs: number
  hideHoldMs?: number
}): ThinkingVisibilityHold {
  if (input.blocked) return { visible: false, heldUntilMs: undefined }
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
