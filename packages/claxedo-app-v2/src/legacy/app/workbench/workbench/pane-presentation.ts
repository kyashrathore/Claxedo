import { createContext, useContext } from "solid-js"

export type PanePresentation = "docked" | "floating"

/**
 * Resolves how a pane's content should lay itself out. A pane is "floating"
 * while the workspace panel covers it at full view, so the session inside
 * renders its last turn and composer as an overlay instead of a column.
 */
export type PanePresentationResolver = {
  presentationFor: (paneId: string) => PanePresentation
}

/**
 * A pane floats while the workspace panel covers it at full view, provided its
 * content can float (a session renders its last turn and composer over the
 * panel; a terminal or file tab has no floating layout and stays docked, which
 * hides it under the panel). The panel targets a pane by id; a targetless
 * panel is attached to the focused pane, the same rule
 * `workspacePanelMatchesFocusedPane` applies.
 */
export function resolvePanePresentation(input: {
  paneId: string
  contentFloats: boolean
  panelOpen: boolean
  panelFullWidth: boolean
  targetPaneId: string | undefined
  focusedPaneId: string | null | undefined
}): PanePresentation {
  if (!input.panelOpen || !input.panelFullWidth || !input.contentFloats) return "docked"
  const targeted = input.targetPaneId === undefined
    ? input.paneId === input.focusedPaneId
    : input.targetPaneId === input.paneId
  return targeted ? "floating" : "docked"
}

const dockedResolver: PanePresentationResolver = {
  presentationFor: () => "docked",
}

const PanePresentationContext = createContext(dockedResolver)

export const PanePresentationProvider = PanePresentationContext.Provider

export function usePanePresentation() {
  return useContext(PanePresentationContext)
}
