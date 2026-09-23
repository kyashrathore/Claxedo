type TerminalSessionContext = {
  sessionId?: string
  directory?: string
  content?: {
    workspaceRouteId?: string
  }
}

/**
 * Return a session only when its surface is authoritatively scoped to the PTY's
 * target workspace. An opaque workspace route id wins over a directory because
 * multiple workspaces may intentionally share the same path.
 */
export function terminalSessionIdForWorkspace(
  context: TerminalSessionContext | undefined,
  target: { directory: string; workspaceRouteId?: string },
) {
  if (!context?.sessionId) return undefined
  if (target.workspaceRouteId) {
    return context.content?.workspaceRouteId === target.workspaceRouteId
      ? context.sessionId
      : undefined
  }
  return context.directory === target.directory ? context.sessionId : undefined
}
