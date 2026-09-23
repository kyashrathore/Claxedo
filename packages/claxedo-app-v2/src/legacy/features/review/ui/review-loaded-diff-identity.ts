/**
 * Deterministic identity for the complete Review model. Unlike rendered row
 * markers, this remains authoritative when the Review surface virtualizes all
 * but the current viewport.
 */
export function reviewLoadedDiffIdentity(paths: readonly string[]) {
  return JSON.stringify(paths.toSorted())
}
