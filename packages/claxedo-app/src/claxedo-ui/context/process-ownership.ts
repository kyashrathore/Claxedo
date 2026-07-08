import type { ClaxedoStateApi } from "../state"

export interface ProcessOwnershipAPI {
  ownProcess(configId: string, ptyId: string): void
  disownProcess(ptyId: string): void
  ownerOf(ptyId: string): string | undefined
  processOwnedPtyIds(): string[]
  expectProcessPty(): void
  resolveProcessPty(): void
  resolveInitialProcessPty(): void
}

export interface TerminalTabOps {
  removeTerminalTabsByPtyIds(ptyIds: Set<string>): void
  removeAutoCreatedTab(ptyId: string): void
  addTerminalTab(dir: string, ptyId: string, title: string): string | undefined
  setActiveTab(surfaceId: string): void
}

export function createProcessOwnership(state: ClaxedoStateApi): ProcessOwnershipAPI {
  return {
    ownProcess(configId, ptyId) {
      state.terminal.own(`process:${configId}`, ptyId)
    },

    disownProcess(ptyId) {
      state.terminal.disown(ptyId)
    },

    ownerOf(ptyId) {
      return state.terminal.owner(ptyId)
    },

    processOwnedPtyIds() {
      return state.terminal.processOwnedPtyIds()
    },

    expectProcessPty() {
      state.terminal.expectProcessPty()
    },

    resolveProcessPty() {
      state.terminal.resolveProcessPty()
    },

    resolveInitialProcessPty() {
      state.terminal.resolveInitialProcessPty()
    },
  }
}

export function createTerminalTabOps(state: ClaxedoStateApi): TerminalTabOps {
  return {
    removeTerminalTabsByPtyIds(ptyIds) {
      if (ptyIds.size === 0) return
      for (const meta of state.meta.all()) {
        if (meta.type === "terminal" && meta.terminalId && ptyIds.has(meta.terminalId)) {
          state.layout.closeContent(meta.id)
        }
      }
    },

    removeAutoCreatedTab(ptyId) {
      const match = state.meta.find((meta) => meta.type === "terminal" && meta.terminalId === ptyId)
      if (match) state.layout.closeContent(match.id)
    },

    addTerminalTab(dir, ptyId, title) {
      return state.layout.openTerminal(dir, ptyId, title)
    },

    setActiveTab(surfaceId) {
      state.layout.showContent(surfaceId)
    },
  }
}
