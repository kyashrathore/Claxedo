import type { ModelChoice } from "./types"

export function sameModelKey(left: ModelChoice | undefined, right: ModelChoice | undefined) {
  if (!left || !right) return left === right
  return left.providerId === right.providerId && left.modelId === right.modelId && left.variant === right.variant
}
