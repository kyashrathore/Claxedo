// Pure-state harness — exercises reducers via the same shape that the hook
// would expose, but without any DOM/Solid render. This makes most behavior
// assertions runnable under bun:test (which can't transform Solid JSX).

import { reducers } from "../reducers/index"
import { selectors as pureSelectors } from "../selectors"
import { validate } from "../validate"
import type { Edge, Pane, PaneRect, Snapshot, WorkbenchState } from "../types"

export type StateHarness = {
  state: () => WorkbenchState
  api: {
    contents: {
      add: (id: string) => void
      remove: (id: string) => void
    }
    panes: {
      assign: (paneId: string, contentId: string | null) => void
    }
    split: {
      split: (targetPaneId: string, edge: Edge, contentId: string) => void
      close: (paneId: string, opts?: { destroyContent: boolean }) => void
      move: (contentId: string, fromPaneId: string, toPaneId: string | "new") => void
      focus: (paneId: string) => void
      resize: (path: ReadonlyArray<"a" | "b">, ratio: number) => void
    }
    navigation: {
      show: (contentId: string) => void
    }
    selectors: {
      aliveContents: () => readonly string[]
      recentContents: () => readonly string[]
      contentPane: (contentId: string) => string | null
      visiblePanes: () => readonly Pane[]
      paneRect: (paneId: string) => PaneRect | undefined
      focusedContent: () => string | null
      snapshotFor: (contentId: string) => Snapshot | undefined
    }
  }
}

export function harness(initial?: WorkbenchState): StateHarness {
  let state: WorkbenchState = initial ?? validate(undefined).state
  const apply = (fn: (s: WorkbenchState) => WorkbenchState) => {
    state = fn(state)
  }
  const api = {
    contents: {
      add: (id: string) => apply((s) => reducers.contents.add(s, id)),
      remove: (id: string) => apply((s) => reducers.contents.remove(s, id)),
    },
    panes: {
      assign: (paneId: string, cid: string | null) => apply((s) => reducers.panes.assign(s, paneId, cid)),
    },
    split: {
      split: (targetPaneId: string, edge: Edge, contentId: string) =>
        apply((s) => reducers.split.split(s, targetPaneId, edge, contentId)),
      close: (paneId: string, opts?: { destroyContent: boolean }) =>
        apply((s) => reducers.split.close(s, paneId, opts ?? { destroyContent: false })),
      move: (contentId: string, fromPaneId: string, toPaneId: string | "new") =>
        apply((s) => reducers.split.move(s, contentId, fromPaneId, toPaneId)),
      focus: (paneId: string) => apply((s) => reducers.split.focus(s, paneId)),
      resize: (path: ReadonlyArray<"a" | "b">, ratio: number) => apply((s) => reducers.split.resize(s, path, ratio)),
    },
    navigation: {
      show: (cid: string) => apply((s) => reducers.navigation.show(s, cid)),
    },
    selectors: {
      aliveContents: () => pureSelectors.aliveContents(state),
      recentContents: () => pureSelectors.recentContents(state),
      contentPane: (id: string) => pureSelectors.contentPane(state, id),
      visiblePanes: () => pureSelectors.visiblePanes(state),
      paneRect: (id: string) => pureSelectors.paneRect(state, id),
      focusedContent: () => pureSelectors.focusedContent(state),
      snapshotFor: (id: string) => pureSelectors.snapshotFor(state, id),
    },
  }
  return {
    state: () => state,
    api,
  }
}
