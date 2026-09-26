export function fileTreeRevealWindow(input: {
  readonly paths: readonly string[]
  readonly active: string | undefined
  readonly batchSize: number
  readonly batchesBefore: number
  readonly batchesAfter: number
}): { readonly start: number; readonly end: number } {
  if (!Number.isFinite(input.batchSize) || input.batchSize <= 0) {
    return { start: 0, end: input.paths.length }
  }
  const active = input.active
  const index = active ? input.paths.findIndex((path) => active === path || active.startsWith(`${path}/`)) : -1
  const anchored = index === -1 ? 0 : Math.floor(index / input.batchSize) * input.batchSize
  const start = Math.max(0, anchored - input.batchesBefore * input.batchSize)
  const end = Math.min(input.paths.length, anchored + (1 + input.batchesAfter) * input.batchSize)
  return { start, end }
}

export type TreeKeyAction =
  { readonly kind: "focus"; readonly index: number } | { readonly kind: "toggle" } | { readonly kind: "none" }

export function resolveTreeKeyAction(input: {
  readonly key: string
  readonly index: number
  readonly count: number
  readonly expanded: boolean | undefined
}): TreeKeyAction {
  const { key, index, count } = input
  if (count === 0) return { kind: "none" }
  const clamp = (value: number) => Math.max(0, Math.min(count - 1, value))
  switch (key) {
    case "ArrowDown":
      return { kind: "focus", index: clamp(index + 1) }
    case "ArrowUp":
      return { kind: "focus", index: clamp(index - 1) }
    case "Home":
      return { kind: "focus", index: 0 }
    case "End":
      return { kind: "focus", index: count - 1 }
    case "ArrowRight":
      if (input.expanded === false) return { kind: "toggle" }
      if (input.expanded === true) return { kind: "focus", index: clamp(index + 1) }
      return { kind: "none" }
    case "ArrowLeft":
      if (input.expanded === true) return { kind: "toggle" }
      return { kind: "focus", index: clamp(index - 1) }
    default:
      return { kind: "none" }
  }
}

export const treeKey = (path: string) => path.replace(/[\\/]+$/, "").replaceAll("\\", "/")
