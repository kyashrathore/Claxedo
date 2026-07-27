export function createRailHeaderActions(input: {
  focusedPaneWorkspaceDir: (paneId: string | undefined) => string | undefined
  focusedSplitPaneId: () => string | undefined
  focusedSurfaceWorkspaceToolsBlocked: () => boolean
  onNewSession?: (workspaceDir?: string, paneId?: string) => void
  onNewTerminal?: (workspaceDir: string, command?: string, title?: string, paneId?: string) => void
  /**
   * Open the terminal creator instead of a pty. The header's directory is
   * `sidebarDir() ?? focusedPaneWorkspaceDir(paneId)` — a fallback chain, not a
   * choice the user made — so starting a process in it without asking is the
   * same guess the rail's project headers used to make.
   */
  onNewTerminalDraft?: (workspaceDir: string, paneId?: string) => void
  /** Seeds the creator when no workspace is focused (WorkGraph, Marketplace, …). */
  fallbackWorkspaceDir?: () => string | undefined
  sidebarDir: () => string | undefined
}) {
  const headerWorkspaceDir = (paneId: string | undefined) =>
    input.sidebarDir() ?? input.focusedPaneWorkspaceDir(paneId)

  return {
    createSession: () => {
      const paneId = input.focusedSplitPaneId()
      input.onNewSession?.(headerWorkspaceDir(paneId), paneId)
    },
    createTerminal: (command?: string, title?: string) => {
      if (input.focusedSurfaceWorkspaceToolsBlocked()) return
      const paneId = input.focusedSplitPaneId()
      const workspaceDir = headerWorkspaceDir(paneId)
      if (!workspaceDir) return
      input.onNewTerminal?.(workspaceDir, command, title, paneId)
    },
    createTerminalDraft: () => {
      // No `focusedSurfaceWorkspaceToolsBlocked()` guard, unlike `createTerminal`
      // above. That guard means the focused surface has no workspace — true on
      // WorkGraph, Marketplace and Global chat — and refusing there would hide
      // the one control whose entire job is to ask which workspace to use.
      const paneId = input.focusedSplitPaneId()
      const workspaceDir = headerWorkspaceDir(paneId) ?? input.fallbackWorkspaceDir?.()
      if (!workspaceDir) return
      input.onNewTerminalDraft?.(workspaceDir, paneId)
    },
  }
}
