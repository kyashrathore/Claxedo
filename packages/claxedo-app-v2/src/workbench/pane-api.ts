import type { AnyPaneKind, PaneKind } from "@/shell"
import { reducers } from "./reducers/index"
import { selectors } from "./selectors"
import type { WorkbenchState } from "./types"

export type PaneView = { readonly paneId: string; readonly contentId: string; readonly kind: AnyPaneKind; readonly state: unknown }

export type PaneApi = {
  readonly panes: () => readonly PaneView[]
  readonly activePane: () => PaneView | undefined
  readonly openPane: <State>(kind: PaneKind<State>, state: State) => string
  readonly replacePane: <State>(paneId: string, kind: PaneKind<State>, state: State) => void
  readonly closePane: (paneId: string) => void
}

export type PaneApiHost = {
  readonly layout: () => WorkbenchState
  readonly content: (contentId: string) => { readonly kind: AnyPaneKind; readonly state: unknown } | undefined
  readonly open: <State>(kind: PaneKind<State>, state: State, focus?: boolean) => string
  readonly apply: (mutation: (layout: WorkbenchState) => WorkbenchState) => void
  readonly closeContent: (contentId: string) => void
}

export function createPaneApi(host: PaneApiHost): PaneApi {
  const panes = (): readonly PaneView[] =>
    selectors.visiblePanes(host.layout()).flatMap((pane) => {
      if (!pane.contentId) return []
      const opened = host.content(pane.contentId)
      return opened ? [{ paneId: pane.id, contentId: pane.contentId, kind: opened.kind, state: opened.state }] : []
    })
  const openPane = <State,>(kind: PaneKind<State>, state: State): string => {
    const contentId = host.open(kind, state, true)
    const paneId = selectors.contentPane(host.layout(), contentId)
    if (!paneId) throw new Error(`Content ${contentId} did not land in a pane`)
    return paneId
  }
  const replacePane = <State,>(paneId: string, kind: PaneKind<State>, state: State): void => {
    const previous = host.layout().panes.find((pane) => pane.id === paneId)?.contentId ?? null
    const contentId = host.open(kind, state, false)
    host.apply((layout) => reducers.panes.assign(layout, paneId, contentId))
    if (previous && previous !== contentId) host.apply((layout) => reducers.contents.remove(layout, previous))
  }
  return {
    panes,
    activePane: () => {
      const focused = host.layout().focusedPaneId
      return panes().find((pane) => pane.paneId === focused)
    },
    openPane,
    replacePane,
    closePane: (paneId) => {
      const pane = host.layout().panes.find((candidate) => candidate.id === paneId)
      if (!pane) return
      if (pane.contentId) host.closeContent(pane.contentId)
      else host.apply((layout) => reducers.split.close(layout, paneId, { destroyContent: false }))
    },
  }
}
