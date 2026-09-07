// Navigator slice — the sidebar placement's persisted geometry: column width
// and the active Files / Changes / Processes tab.

import type { Accessor } from "solid-js"
import type { SetStoreFunction } from "solid-js/store"
import type { WorkspacePanelNavigator } from "../../../features/workspaces/ui/panel/workspace-panel-state"
import type { ClaxedoState } from "./types"

export const NAVIGATOR_MIN_WIDTH = 260
export const NAVIGATOR_MAX_WIDTH = 520
export const NAVIGATOR_DEFAULT_WIDTH = 320

export function clampNavigatorWidth(width: unknown): number {
  if (typeof width !== "number" || !Number.isFinite(width)) return NAVIGATOR_DEFAULT_WIDTH
  return Math.min(Math.max(width, NAVIGATOR_MIN_WIDTH), NAVIGATOR_MAX_WIDTH)
}

export type NavigatorSliceApi = {
  width: Accessor<number>
  tab: Accessor<WorkspacePanelNavigator>

  setWidth(width: number): void
  select(tab: WorkspacePanelNavigator): void
}

export function createNavigatorSlice(input: {
  state: ClaxedoState
  setState: SetStoreFunction<ClaxedoState>
}): NavigatorSliceApi {
  const { state, setState } = input

  return {
    width: () => state.navigator.width,
    tab: () => state.navigator.tab,

    setWidth(width) {
      setState("navigator", "width", clampNavigatorWidth(width))
    },

    select(tab) {
      setState("navigator", "tab", tab)
    },
  }
}
