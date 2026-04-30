/**
 * Resolves the effective session ID from multiple sources.
 *
 * Priority chain:
 *   1. Explicit prop (e.g. embedded PromptInput in page dock)
 *   2. SessionParams context (split/group mode)
 *   3. Route params (standard route-based navigation)
 *
 * Extracted so the resolution logic can be tested independently of the
 * full PromptInput component tree.
 */
export function resolveSessionId(
  propSessionID: string | undefined,
  sessionParamsId: string | undefined,
  routeParamsId: string | undefined,
): string | undefined {
  return propSessionID ?? sessionParamsId ?? routeParamsId
}
