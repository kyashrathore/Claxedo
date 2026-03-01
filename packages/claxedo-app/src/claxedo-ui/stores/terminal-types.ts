/**
 * Terminal Store Types — Interface Contract for Process Ownership
 *
 * Defines the ownership API consumed by the process pane.
 *
 * Ownership model:
 * - "tab" owner: PTY belongs to a tab — closing the tab closes the PTY.
 * - "process:<configId>" owner: PTY belongs to the process pane — tab close
 *   must NOT close the PTY. The process pane manages its lifecycle.
 * - undefined: PTY has no owner — eligible for auto-tab-creation by the
 *   detection effect.
 */

export type PtyOwnerType = "tab" | `process:${string}`

/**
 * Process ownership operations for a specific directory.
 *
 * Scoped to a single workspace directory.
 */
export interface ProcessOwnershipAPI {
  /**
   * Mark a PTY as owned by a process.
   * Prevents the terminal detection effect from creating tabs for it.
   */
  ownProcess(configId: string, ptyId: string): void

  /**
   * Release process ownership of a PTY.
   * Called when "Open in Tab" moves a process PTY into a regular tab.
   */
  disownProcess(ptyId: string): void

  /**
   * Get the owner of a PTY, if any.
   * Returns the owner string (e.g. "process:configId" or tab ID) or undefined.
   */
  ownerOf(ptyId: string): string | undefined

  /**
   * Return all PTY IDs currently owned by a process (owner starts with "process:").
   * Used for stale cleanup on reload.
   */
  processOwnedPtyIds(): string[]

  /**
   * Signal that a process PTY creation is in flight.
   * Prevents the detection effect from creating a tab for the pty.created SSE
   * that arrives before process.started registers ownership.
   */
  expectProcessPty(): void

  /**
   * Signal that a process PTY creation has completed (or failed).
   * Must be called in a finally block to ensure the counter always decrements.
   */
  resolveProcessPty(): void

  /**
   * Resolve the initial pending count (set to 1 at store creation time).
   * Called by ProcessPaneProvider on mount after fetchProcesses completes.
   */
  resolveInitialProcessPty(): void
}

/**
 * Tab lifecycle operations needed by the process pane.
 *
 * These operations manipulate terminal tabs across groups.
 */
export interface TerminalTabOps {
  /** Remove terminal tabs matching a set of PTY IDs from all groups. */
  removeTerminalTabsByPtyIds(ptyIds: Set<string>): void

  /** Remove a single auto-created tab for a PTY from all groups. */
  removeAutoCreatedTab(ptyId: string): void

  /** Add a terminal tab to the focused group and return the tab ID. */
  addTerminalTab(dir: string, ptyId: string, title: string): string | undefined

  /** Set a tab as active. */
  setActiveTab(tabId: string): void
}
