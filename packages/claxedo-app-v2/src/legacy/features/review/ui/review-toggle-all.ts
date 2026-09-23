export function reviewToggleAllAction(openDiffCount: number): "expand" | "collapse" {
  return openDiffCount > 0 ? "collapse" : "expand"
}
