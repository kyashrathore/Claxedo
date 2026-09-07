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

const dockedResolver: PanePresentationResolver = {
  presentationFor: () => "docked",
}

const PanePresentationContext = createContext<PanePresentationResolver>(dockedResolver)

export const PanePresentationProvider = PanePresentationContext.Provider

export function usePanePresentation() {
  return useContext(PanePresentationContext)
}
