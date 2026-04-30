// Workspace-panel slice — wraps the existing pure helpers in
// `workspace-panel/workspace-panel-state.ts` (which we keep, since they are
// already pure data transitions). This slice gives the orchestration layer a
// minimal facade that owns the live state.

import type { Accessor } from "solid-js"
import type { SetStoreFunction } from "solid-js/store"
import {
  addBrowserPanelTab,
  closePanelTab,
  closeWorkspacePanel,
  openWorkspacePanel,
  retargetWorkspacePanel,
  setActivePanelTab,
  updateBrowserTabMeta,
  type WorkspacePanelMode,
  type WorkspacePanelState,
  type WorkspacePanelTarget,
} from "../workspace-panel/workspace-panel-state"
import type { ClaxedoState } from "./types"

export type WorkspacePanelSliceApi = {
  state: Accessor<WorkspacePanelState>
  open(mode: WorkspacePanelMode, target?: WorkspacePanelTarget): void
  close(): void
  toggle(mode: WorkspacePanelMode, target?: WorkspacePanelTarget): void
  select(mode: WorkspacePanelMode): void
  retarget(target?: WorkspacePanelTarget): void
  addBrowserTab(input?: { url?: string; title?: string }): void
  closeTab(tabId: string): void
  setActiveTab(tabId: string): void
  updateBrowserTab(tabId: string, patch: { url?: string; title?: string }): void
}

export function createWorkspacePanelSlice(input: {
  state: ClaxedoState
  setState: SetStoreFunction<ClaxedoState>
  /** Resolves the natural target for an open call when the caller doesn't pass one. */
  defaultTarget: () => WorkspacePanelTarget
}): WorkspacePanelSliceApi {
  const { state, setState, defaultTarget } = input

  const accessor: Accessor<WorkspacePanelState> = () => state.workspacePanel

  return {
    state: accessor,
    open(mode, target) {
      setState(
        "workspacePanel",
        openWorkspacePanel(state.workspacePanel, {
          ...defaultTarget(),
          ...target,
          mode,
        }),
      )
    },
    close() {
      setState("workspacePanel", closeWorkspacePanel(state.workspacePanel))
    },
    toggle(mode, target) {
      const current = state.workspacePanel
      if (current.open && current.mode === mode) {
        setState("workspacePanel", closeWorkspacePanel(current))
        return
      }
      setState(
        "workspacePanel",
        openWorkspacePanel(current, { ...defaultTarget(), ...target, mode }),
      )
    },
    select(mode) {
      setState(
        "workspacePanel",
        openWorkspacePanel(state.workspacePanel, { ...defaultTarget(), mode }),
      )
    },
    retarget(target) {
      setState(
        "workspacePanel",
        retargetWorkspacePanel(state.workspacePanel, { ...defaultTarget(), ...target }),
      )
    },
    addBrowserTab(input) {
      setState("workspacePanel", addBrowserPanelTab(state.workspacePanel, input ?? {}))
    },
    closeTab(tabId) {
      setState("workspacePanel", closePanelTab(state.workspacePanel, tabId))
    },
    setActiveTab(tabId) {
      setState("workspacePanel", setActivePanelTab(state.workspacePanel, tabId))
    },
    updateBrowserTab(tabId, patch) {
      setState("workspacePanel", updateBrowserTabMeta(state.workspacePanel, tabId, patch))
    },
  }
}
