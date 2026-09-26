export function loadedDiffIdentity(paths: readonly string[]): string {
  return JSON.stringify([...paths].sort())
}
