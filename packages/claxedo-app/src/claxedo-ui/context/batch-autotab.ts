/**
 * Batch Auto-Tab Listener
 *
 * Listens for session.created and pty.created events from sandbox directories
 * and automatically adds tabs without stealing focus. This enables the
 * batch_issues MCP tool to create worktrees with agents that automatically
 * appear as tabs in the UI.
 */

type TabActions = {
  addSession(dir: string, sessionId: string, title: string): string
  addTerminal(dir: string, terminalId: string, title: string): string
  findSession(dir: string, sessionId: string): any | undefined
  findTerminal(dir: string, terminalId: string): any | undefined
  activeId(): string | null
  setActive(id: string | null): void
}

type ProjectInfo = {
  worktree: string
  sandboxes?: string[]
}

type EventDetails = {
  type: string
  properties?: {
    info?: {
      id?: string
      title?: string
      directory?: string
      cwd?: string
    }
  }
}

type ListenEvent = {
  name: string // directory
  details: EventDetails
}

export type BatchAutoTabDeps = {
  listen: (fn: (e: ListenEvent) => void) => () => void
  topTabs: Pick<TabActions, "addSession" | "addTerminal" | "findSession" | "findTerminal" | "activeId" | "setActive">
  projects: () => ProjectInfo[]
}

/**
 * Check if a directory is a sandbox (not a main project worktree)
 */
function isSandboxDirectory(directory: string, projects: ProjectInfo[]): boolean {
  if (!directory || directory === "global") return false

  for (const project of projects) {
    // It's a sandbox if it appears in the sandboxes list
    if (project.sandboxes?.includes(directory)) return true
  }
  return false
}

/**
 * Create a listener that auto-adds tabs for sessions/ptys created in sandbox directories.
 * Returns a cleanup function to unsubscribe.
 */
export function createBatchAutoTabListener(deps: BatchAutoTabDeps): () => void {
  return deps.listen((e) => {
    const directory = e.name
    const event = e.details

    if (!directory || !event?.type) return

    const projects = deps.projects()
    if (!isSandboxDirectory(directory, projects)) return

    const info = event.properties?.info
    if (!info?.id) return

    // Save current active tab to restore after adding
    const activeIdBefore = deps.topTabs.activeId()

    if (event.type === "session.created") {
      // Skip if tab already exists for this session
      if (deps.topTabs.findSession(directory, info.id)) return

      deps.topTabs.addSession(directory, info.id, info.title || "Session")

      // Restore focus — addSession may have changed the active tab
      if (activeIdBefore !== null) {
        deps.topTabs.setActive(activeIdBefore)
      }
      return
    }

    if (event.type === "pty.created") {
      // Skip if tab already exists for this PTY
      if (deps.topTabs.findTerminal(directory, info.id)) return

      deps.topTabs.addTerminal(directory, info.id, info.title || "Terminal")

      // Restore focus
      if (activeIdBefore !== null) {
        deps.topTabs.setActive(activeIdBefore)
      }
      return
    }
  })
}
