export type ReviewMode = "uncommitted" | "unstaged" | "staged" | "to-from"

export type ReviewPopoverMode = ReviewMode

export const REVIEW_POPOVER_MODES = [
  "uncommitted",
  "unstaged",
  "staged",
  "to-from",
] as const satisfies readonly ReviewPopoverMode[]
