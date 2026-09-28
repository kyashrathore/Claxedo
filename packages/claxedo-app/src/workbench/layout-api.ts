import { createMemo, type Accessor } from "solid-js"
import type { Handing } from "./handover"
import { reducers } from "./reducers/index"
import { selectors } from "./selectors"
import type { Edge, MovePaneTarget, Pane, PaneRect, Snapshot, SplitPath, WorkbenchState } from "./types"

export type WorkbenchApi = {
  contents: {
    add: (contentId: string) => void
    open: (contentId: string, focus?: boolean) => void
    remove: (contentId: string) => void
  }
  assignContent: (paneId: string, contentId: string | null) => void
  split: {
    accepts: (targetPaneId: string, contentId: string) => boolean
    split: (targetPaneId: string, edge: Edge, contentId: string) => void
    close: (paneId: string, opts?: { destroyContent: boolean }) => void
    move: (contentId: string, fromPaneId: string, toPaneId: MovePaneTarget) => void
    focus: (paneId: string) => void
    resize: (path: SplitPath, ratio: number) => void
  }
  navigation: { show: (contentId: string) => void }
  splittable: (contentId: string) => boolean
  selectors: {
    aliveContents: () => readonly string[]
    recentContents: () => readonly string[]
    contentPane: (contentId: string) => string | null
    visiblePanes: () => readonly Pane[]
    paneRect: (paneId: string) => PaneRect | undefined
    focusedContent: () => string | null
    shownContent: () => string | null
    mruHiddenContent: () => string | null
    snapshotFor: (contentId: string) => Snapshot | undefined
  }
}

type Apply = (mutation: (layout: WorkbenchState) => WorkbenchState) => void
type Splittable = (contentId: string) => boolean

function selectorApi(layout: Accessor<WorkbenchState>, handing: Accessor<Handing | undefined>, splittable: Splittable): WorkbenchApi["selectors"] {
  const focusedContent = createMemo(() => selectors.focusedContent(layout()))
  const shownContent = createMemo(() => selectors.shownContent(layout(), handing()))
  return {
    aliveContents: () => selectors.aliveContents(layout()),
    recentContents: () => selectors.recentContents(layout()),
    contentPane: (id) => selectors.contentPane(layout(), id),
    visiblePanes: () => selectors.visiblePanes(layout()),
    paneRect: (id) => selectors.paneRect(layout(), id),
    focusedContent,
    shownContent,
    mruHiddenContent: () => selectors.mruHiddenContent(layout(), splittable),
    snapshotFor: (id) => selectors.snapshotFor(layout(), id),
  }
}

function splitsBeside(state: WorkbenchState, splittable: Splittable, targetPaneId: string, contentId: string): boolean {
  const target = state.panes.find((pane) => pane.id === targetPaneId)?.contentId
  return splittable(contentId) && (!target || splittable(target))
}

export function createLayoutApi(layout: Accessor<WorkbenchState>, apply: Apply, handing: Accessor<Handing | undefined>, splittable: Splittable): WorkbenchApi {
  const show = (s: WorkbenchState, id: string, focus: boolean) => (focus ? reducers.navigation.show(reducers.contents.add(s, id), id) : reducers.contents.add(s, id))
  return {
    contents: {
      add: (id) => apply((s) => reducers.contents.add(s, id)),
      open: (id, focus = true) => apply((s) => show(s, id, focus)),
      remove: (id) => apply((s) => reducers.contents.remove(s, id)),
    },
    assignContent: (paneId, contentId) => apply((s) => reducers.panes.assign(s, paneId, contentId)),
    split: {
      accepts: (targetPaneId, contentId) => splitsBeside(layout(), splittable, targetPaneId, contentId),
      split: (targetPaneId, edge, contentId) =>
        apply((s) => (splitsBeside(s, splittable, targetPaneId, contentId) ? reducers.split.splitPane(s, targetPaneId, edge, contentId) : s)),
      close: (paneId, opts) => apply((s) => reducers.split.closePane(s, paneId, opts ?? { destroyContent: false })),
      move: (contentId, fromPaneId, toPaneId) => apply((s) => reducers.split.moveContent(s, contentId, fromPaneId, toPaneId)),
      focus: (paneId) => apply((s) => reducers.split.focusPane(s, paneId)),
      resize: (path, ratio) => apply((s) => reducers.split.resizeSplit(s, path, ratio)),
    },
    navigation: { show: (contentId) => apply((s) => reducers.navigation.show(s, contentId)) },
    splittable,
    selectors: selectorApi(layout, handing, splittable),
  }
}
