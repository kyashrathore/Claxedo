/**
 * The direct-session resolver has no work on workspace/page/terminal routes.
 * Keep its expensive active-surface and inventory dependencies outside the
 * reactive graph until a direct session route actually exists.
 */
export function directSessionResolutionDependencies<T extends readonly unknown[]>(
  sessionId: string | undefined,
  dependencies: () => T,
): readonly [undefined] | readonly [string, ...T] {
  if (!sessionId) return [undefined]
  return [sessionId, ...dependencies()]
}

export function activeSurfaceIsDirectSessionChild(
  routeSessionId: string,
  surface: { sessionId?: string; returnFocus?: { parentSessionId?: string } } | undefined,
) {
  return surface?.sessionId !== routeSessionId && surface?.returnFocus?.parentSessionId === routeSessionId
}

export function collectRouteResolutionDirectories(
  projectDirectories: readonly (string | undefined)[],
  metadataDirectories: readonly (string | undefined)[],
) {
  const seen = new Set<string>()
  const directories: string[] = []
  for (const directory of [...projectDirectories, ...metadataDirectories]) {
    if (!directory || directory === "/workspace" || seen.has(directory)) continue
    seen.add(directory)
    directories.push(directory)
  }
  return directories
}
