export function clampFocus(index: number, count: number): number {
  return Math.max(0, Math.min(count - 1, index))
}

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

export function isAnswered(input: {
  answers: readonly string[] | undefined
  customOn: boolean | undefined
  custom: string | undefined
}): boolean {
  if ((input.answers?.length ?? 0) > 0) return true
  return input.customOn === true && (input.custom ?? "").trim().length > 0
}

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

type Edges = { top: number; bottom: number }

export function questionPromptMaxHeight(input: {
  stickyHeadBottom: number
  dock: Edges
  root: Edges
  floatingArea?: Edges
}): number | undefined {
  const gap = 8
  const floor = 240
  if (input.floatingArea) {
    const area = input.floatingArea.bottom - input.floatingArea.top
    const dock = input.dock.bottom - input.dock.top
    const root = input.root.bottom - input.root.top
    return Math.max(floor, Math.floor(area - dock + root - gap))
  }
  if (!input.stickyHeadBottom) return undefined
  const below = Math.max(0, input.dock.bottom - input.root.bottom)
  return Math.max(floor, Math.floor(input.dock.bottom - input.stickyHeadBottom - gap - below))
}
