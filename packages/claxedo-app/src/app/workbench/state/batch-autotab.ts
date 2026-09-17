/**
 * Batch Auto-Tab Listener.
 *
 * Listens for a session's `session.lifecycle` "created" and a terminal's
 * `pty.created` from sandbox directories and automatically adds tabs without
 * stealing focus. This enables the workspace automation to create worktrees
 * with agents that automatically appear as tabs in the UI.
 *
 * The function is parameterized: the caller passes simple `addSession`,
 * `addTerminal`, `findSession`, `findTerminal` adapters wired to the new
 * `state.layout.*` orchestration. This keeps the listener pure and trivially
 * testable.
 */

import { readString } from "@/lib/record"
import type { useClaxedoEventsOptional } from "@/app/integrations/claxedo-events"

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

export type BatchAutoTabDeps = {
  /** The events emitter; this reads its `session.lifecycle` and `pty.created` control frames. */
  events: Pick<NonNullable<ReturnType<typeof useClaxedoEventsOptional>>, "on">
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
  return projects.some((project) =>
    project.worktree !== directory && !!project.sandboxes?.includes(directory),
  )
}

/**
 * Create a listener that auto-adds tabs for sessions/ptys created in sandbox
 * directories. Returns a cleanup function to unsubscribe.
 */
export function createBatchAutoTabListener(deps: BatchAutoTabDeps): () => void {
  const sessions = deps.events.on("session.lifecycle", (event) => {
    if (event.phase !== "created" || !event.sessionID) return
    const directory = event.directory && event.directory !== "global"
      ? event.directory
      : readString(event.info, "directory") || readString(event.info, "cwd")
    if (!directory || !isSandboxDirectory(directory, deps.projects())) return
    if (deps.adapters.findSession(directory, event.sessionID)) return
    deps.adapters.addSession(directory, event.sessionID, readString(event.info, "title") || "Session")
  })
  // The pty's own cwd is the sandbox that decides whether a tab opens; the
  // frame names no directory of its own.
  const terminals = deps.events.on("pty.created", (event) => {
    const directory = event.info.cwd
    if (!directory || !isSandboxDirectory(directory, deps.projects())) return
    if (deps.adapters.findTerminal(directory, event.info.id)) return
    deps.adapters.addTerminal(directory, event.info.id, event.info.title || "Terminal")
  })
  return () => {
    sessions()
    terminals()
  }
}
