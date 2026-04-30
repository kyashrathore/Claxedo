/**
 * Batch Auto-Tab Listener.
 *
 * Listens for session.created and pty.created events from sandbox directories
 * and automatically adds tabs without stealing focus. This enables the
 * batch_issues MCP tool to create worktrees with agents that automatically
 * appear as tabs in the UI.
 *
 * The function is parameterized: the caller passes simple `addSession`,
 * `addTerminal`, `findSession`, `findTerminal` adapters wired to the new
 * `state.layout.*` orchestration. This keeps the listener pure and trivially
 * testable.
 */

type TabActions = {
  addSession(dir: string, sessionId: string, title: string): string | undefined
  addTerminal(dir: string, terminalId: string, title: string): string | undefined
  findSession(dir: string, sessionId: string): { id: string } | undefined
  findTerminal(dir: string, terminalId: string): { id: string } | undefined
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
  /**
   * Adapters wrapping the new state orchestration. The listener does not
   * "steal focus" — adapters must avoid changing the focused content.
   */
  adapters: TabActions
  projects: () => ProjectInfo[]
}

/** Check if a directory is a sandbox (not a main project worktree). */
function isSandboxDirectory(directory: string, projects: ProjectInfo[]): boolean {
  if (!directory || directory === "global") return false
  for (const project of projects) {
    if (project.sandboxes?.includes(directory)) return true
  }
  return false
}

/**
 * Create a listener that auto-adds tabs for sessions/ptys created in sandbox
 * directories. Returns a cleanup function to unsubscribe.
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

    if (event.type === "session.created") {
      // Skip if a content already exists for this session
      if (deps.adapters.findSession(directory, info.id)) return
      deps.adapters.addSession(directory, info.id, info.title || "Session")
      return
    }

    if (event.type === "pty.created") {
      // Skip if a content already exists for this PTY
      if (deps.adapters.findTerminal(directory, info.id)) return
      deps.adapters.addTerminal(directory, info.id, info.title || "Terminal")
      return
    }
  })
}
