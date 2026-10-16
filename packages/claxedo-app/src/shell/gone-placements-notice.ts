import type { ShellKey } from "./i18n"

export type GonePlacementsClosed = { readonly closedTabs: number; readonly routedGone: boolean }

export function gonePlacementsNotice(closed: GonePlacementsClosed): ShellKey | undefined {
  if (closed.routedGone) return "shell.home.placementGone"
  return closed.closedTabs > 0 ? "shell.home.goneTabsClosed" : undefined
}
