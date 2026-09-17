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

import { readField, readString } from "@/lib/record"

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

/**
 * One frame as the caller's emitter delivers it: a presentation frame's
 * `properties`, or a `session.lifecycle` control frame's own fields.
 *
 * `properties` is `unknown` on purpose: declaring the two shapes this reads
 * would force the caller to cast `event.listen` to subscribe at all. The
 * fields it wants are read out below instead of declared here.
 */
type ListenEvent = {
  name: string // directory
  details: { type: string; properties?: unknown; phase?: string; sessionID?: string; info?: unknown }
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
  return projects.some((project) =>
    project.worktree !== directory && !!project.sandboxes?.includes(directory),
  )
}

/**
 * Create a listener that auto-adds tabs for sessions/ptys created in sandbox
 * directories. Returns a cleanup function to unsubscribe.
 */
export function createBatchAutoTabListener(deps: BatchAutoTabDeps): () => void {
  return deps.listen((e) => {
    const event = e.details
    const info = event?.type === "session.lifecycle" ? event.info : readField(event?.properties, "info")
    const id = event?.type === "session.lifecycle" ? event.sessionID : readString(info, "id")
    const title = readString(info, "title")
    const directory =
      e.name && e.name !== "global"
        ? e.name
        : readString(info, "directory") || readString(info, "cwd") || e.name

    if (!directory || !event?.type) return

    const projects = deps.projects()
    if (!isSandboxDirectory(directory, projects)) return

    if (!id) return

    if (event.type === "session.lifecycle" && event.phase === "created") {
      // Skip if a content already exists for this session
      if (deps.adapters.findSession(directory, id)) return
      deps.adapters.addSession(directory, id, title || "Session")
      return
    }

    if (event.type === "pty.created") {
      // Skip if a content already exists for this PTY
      if (deps.adapters.findTerminal(directory, id)) return
      deps.adapters.addTerminal(directory, id, title || "Terminal")
      return
    }
  })
}
