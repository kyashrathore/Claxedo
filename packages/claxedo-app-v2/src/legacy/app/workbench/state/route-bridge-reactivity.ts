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

/**
 * A resolver run where the direct session route stayed put while the focused
 * surface moved to another session is the user focusing a pane, not a route
 * to resolve. `useAppShellRouteSync` moves the URL to the focused pane on that
 * same change; resolving the stale route first would snap focus straight back.
 */
export function focusMovedOffDirectSessionRoute(
  current: readonly [sessionId: string, surfaceSessionId: string | undefined],
  previous: readonly [sessionId: string | undefined, surfaceSessionId?: string | undefined, ...rest: unknown[]] | undefined,
) {
  if (!previous) return false
  const [sessionId, surfaceSessionId] = current
  return previous[0] === sessionId && previous[1] !== surfaceSessionId && surfaceSessionId !== sessionId
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
