/**
 * Process Ownership Adapter
 *
 * Bridges process pane ownership needs to ClaxedoLayout terminal state.
 */

import type { ProcessOwnershipAPI, TerminalTabOps } from "./terminal-types"

/**
 * The subset of ClaxedoLayout API that the process ownership adapter needs.
 * This keeps the adapter loosely coupled to the full ClaxedoLayout interface.
 */
export interface ClaxedoTerminalFacade {
  terminal: {
    own(tab: string, id: string): void
    disown(id: string): void
    owner(id: string): string | undefined
    processOwnedPtyIds(): string[]
    expectProcessPty(): void
    resolveProcessPty(): void
    resolveInitialProcessPty(): void
  }
  split: {
    orderedGroups(): Array<{ id: string }>
    focusedId(): string | undefined
  }
  groupTabs(groupId: string): {
    items(): Array<{ id: string; type: string; terminalId?: string }>
    close(tabId: string): void
    addTerminal(dir: string, ptyId: string, title: string): string | undefined
    setActive(tabId: string): void
  }
  topTabs: {
    addTerminal(dir: string, ptyId: string, title: string): string | undefined
    setActive(tabId: string): void
  }
}

/**
 * Create a ProcessOwnershipAPI that delegates to ClaxedoLayout's terminal state.
 */
export function createProcessOwnership(claxedo: ClaxedoTerminalFacade): ProcessOwnershipAPI {
  return {
    ownProcess(configId: string, ptyId: string) {
      claxedo.terminal.own(`process:${configId}`, ptyId)
    },

    disownProcess(ptyId: string) {
      claxedo.terminal.disown(ptyId)
    },

    ownerOf(ptyId: string) {
      return claxedo.terminal.owner(ptyId)
    },

    processOwnedPtyIds() {
      return claxedo.terminal.processOwnedPtyIds()
    },

    expectProcessPty() {
      claxedo.terminal.expectProcessPty()
    },

    resolveProcessPty() {
      claxedo.terminal.resolveProcessPty()
    },

    resolveInitialProcessPty() {
      claxedo.terminal.resolveInitialProcessPty()
    },
  }
}

/**
 * Create TerminalTabOps that delegates to ClaxedoLayout's group/tab system.
 */
export function createTerminalTabOps(claxedo: ClaxedoTerminalFacade): TerminalTabOps {
  return {
    removeTerminalTabsByPtyIds(ptyIds: Set<string>) {
      if (ptyIds.size === 0) return
      for (const group of claxedo.split.orderedGroups()) {
        const tabs = claxedo.groupTabs(group.id)
        for (const tab of tabs.items()) {
          if (tab.type === "terminal" && tab.terminalId && ptyIds.has(tab.terminalId)) {
            tabs.close(tab.id)
          }
        }
      }
    },

    removeAutoCreatedTab(ptyId: string) {
      for (const group of claxedo.split.orderedGroups()) {
        const tabs = claxedo.groupTabs(group.id)
        const match = tabs.items().find((t: any) => t.type === "terminal" && t.terminalId === ptyId)
        if (match) {
          tabs.close(match.id)
        }
      }
    },

    addTerminalTab(dir: string, ptyId: string, title: string) {
      const focusedId = claxedo.split.focusedId()
      const tabs = focusedId ? claxedo.groupTabs(focusedId) : claxedo.topTabs
      return tabs.addTerminal(dir, ptyId, title)
    },

    setActiveTab(tabId: string) {
      const focusedId = claxedo.split.focusedId()
      const tabs = focusedId ? claxedo.groupTabs(focusedId) : claxedo.topTabs
      tabs.setActive(tabId)
    },
  }
}
