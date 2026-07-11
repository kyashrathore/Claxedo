// Pure keyboard-navigation and answer-merge logic for the question dock. The
// component keeps the store, refs, and `el.focus()` side effects; the decision
// of *which* option index to focus and *what* a keypress means lives here so
// the interaction contract is testable without mounting the dock.

/** Clamp a focus index into `[0, count - 1]` (the "+1" custom row included). */
export function clampFocus(index: number, count: number): number {
  return Math.max(0, Math.min(count - 1, index))
}

/**
 * The initial/roving focus index for a tab: the custom row (== options.length)
 * when the custom answer is active, otherwise the first option already present
 * in `answers` (or 0 when none match).
 */
export function focusIndexForTab(input: {
  options: readonly { label: string }[]
  answers: readonly string[] | undefined
  customOn: boolean | undefined
}): number {
  if (input.customOn === true) return input.options.length
  const answers = input.answers ?? []
  return Math.max(
    0,
    input.options.findIndex((option) => answers.includes(option.label)),
  )
}

/** Whether a tab has a usable answer (a picked option, or non-empty custom text). */
export function isAnswered(input: {
  answers: readonly string[] | undefined
  customOn: boolean | undefined
  custom: string | undefined
}): boolean {
  if ((input.answers?.length ?? 0) > 0) return true
  return input.customOn === true && (input.custom ?? "").trim().length > 0
}

/**
 * Recompute a tab's answer list when the custom text changes.
 *
 * Single-choice: the custom text replaces the answer (empty clears it).
 * Multi-choice: remove the previous custom value, then add the new one unless
 * it is empty or already present.
 */
export function mergeCustomAnswer(input: {
  multi: boolean
  current: readonly string[] | undefined
  previous: string
  next: string
}): string[] {
  const previous = input.previous.trim()
  const next = input.next.trim()

  if (!input.multi) return next ? [next] : []

  const current = input.current ?? []
  const removed = previous ? current.filter((item) => item.trim() !== previous) : [...current]
  if (!next) return removed
  if (removed.some((item) => item.trim() === next)) return removed
  return [...removed, next]
}

export type QuestionKeyAction =
  | { type: "none" }
  | { type: "reject" }
  | { type: "next" }
  | { type: "move"; step: 1 | -1 }
  | { type: "focus"; index: number }

/**
 * Classify a keydown on the question dock.
 *
 * - already handled → none
 * - Escape → reject the request
 * - Cmd/Ctrl+Enter (non-repeat, no Alt) → submit ("next")
 * - Arrow/Home/End, only when focus is inside the options group, not editing,
 *   and with no modifier keys → roving focus movement
 * - anything else → none
 */
export function classifyQuestionKey(
  event: {
    key: string
    metaKey?: boolean
    ctrlKey?: boolean
    altKey?: boolean
    repeat?: boolean
    defaultPrevented?: boolean
  },
  context: { editing: boolean; inOptions: boolean; count: number },
): QuestionKeyAction {
  if (event.defaultPrevented) return { type: "none" }

  if (event.key === "Escape") return { type: "reject" }

  const mod = (event.metaKey || event.ctrlKey) && !event.altKey
  if (mod && event.key === "Enter") {
    if (event.repeat) return { type: "none" }
    return { type: "next" }
  }

  if (context.editing) return { type: "none" }
  if (!context.inOptions) return { type: "none" }
  if (event.altKey || event.ctrlKey || event.metaKey) return { type: "none" }

  if (event.key === "ArrowDown" || event.key === "ArrowRight") return { type: "move", step: 1 }
  if (event.key === "ArrowUp" || event.key === "ArrowLeft") return { type: "move", step: -1 }
  if (event.key === "Home") return { type: "focus", index: 0 }
  if (event.key === "End") return { type: "focus", index: context.count - 1 }

  return { type: "none" }
}
