import type { ClaxedoStateApi } from "../state/provider"

export type WorkspaceSource = {
  directory: string
  name: string
  sessions: SessionSource[]
}

export type SessionSource = {
  sessionId: string
  title?: string
}

export type SidebarSession = {
  sessionId: string
  title: string
  active: boolean
}

export type SidebarTerminal = {
  paneId: string
  terminalId: string
  title: string
  active: boolean
}

export type SidebarWorkspace = {
  directory: string
  name: string
  sessions: SidebarSession[]
  terminals: SidebarTerminal[]
}

export function buildSidebarInventoryFromState(input: {
  workspaces: WorkspaceSource[]
  state: ClaxedoStateApi
}): SidebarWorkspace[] {
  const focused = input.state.wb.selectors.focusedContent()

  return input.workspaces.map((workspace) => ({
    directory: workspace.directory,
    name: workspace.name,
    sessions: workspace.sessions.map((session) => ({
      sessionId: session.sessionId,
      title: session.title || "Session",
      active: focused
        ? (() => {
            const meta = input.state.meta.get(focused)
            return (
              !!meta &&
              (meta.type === "session" || meta.type === "context") &&
              meta.directory === workspace.directory &&
              meta.sessionId === session.sessionId
            )
          })()
        : false,
    })),
    terminals: input.state.meta
      .all()
      .filter((meta) => meta.type === "terminal" && meta.directory === workspace.directory && meta.terminalId)
      .map((meta) => ({
        paneId: meta.id,
        terminalId: meta.terminalId!,
        title: meta.content?.title || "Terminal",
        active: meta.id === focused,
      })),
  }))
}
