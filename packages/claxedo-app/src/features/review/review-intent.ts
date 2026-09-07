export type ReviewMode = "uncommitted" | "unstaged" | "staged" | "to-from"

export const reviewModeLabel: Record<ReviewMode, string> = {
  uncommitted: "Uncommitted",
  unstaged: "Unstaged",
  staged: "Staged",
  "to-from": "to / from",
}
