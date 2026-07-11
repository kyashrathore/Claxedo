import { createContext, useContext, type JSX } from "solid-js"
import type { Pane, Snapshot, WorkbenchState, Edge, PaneRect } from "./types"
import { reducers } from "./reducers"
import { selectors as pureSelectors } from "./selectors"

export type WorkbenchProviderProps = {
  state: WorkbenchState
  onChange: (next: WorkbenchState) => void
  children: JSX.Element
}

type WorkbenchContextValue = {
  getState: () => WorkbenchState
  onChange: (next: WorkbenchState) => void
}

const WorkbenchContext = createContext<WorkbenchContextValue | undefined>(undefined)

export function WorkbenchProvider(props: WorkbenchProviderProps): JSX.Element {
  // Same-task scratch cache so chained synchronous mutations (e.g. 10 rapid
  // sidebar clicks spawning terminals) see each other's writes. Without this,
  // every `apply` reads `props.state` — which only re-evaluates after the
  // store update has propagated through SolidJS — so each mutation in the
  // same tick computes its next state off the same stale base and only the
  // last `onChange` wins (9 out of 10 spawned terminals are lost). The cache
  // holds the most recent local write until the next microtask, at which
  // point upstream props are guaranteed to have caught up.
  const value: WorkbenchContextValue = {
    getState: () => props.state,
    onChange: (next) => props.onChange(next),
  }
  return (
    <WorkbenchContext.Provider value={value}>
      {props.children}
    </WorkbenchContext.Provider>
  )
}

export function useWorkbenchContext(): WorkbenchContextValue {
  const ctx = useContext(WorkbenchContext)
  if (!ctx) throw new Error("useWorkbench must be used inside <WorkbenchProvider>")
  return ctx
}

export type UseWorkbench = {
  state: WorkbenchState

  contents: {
    add: (contentId: string) => void
    remove: (contentId: string) => void
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
    mruHiddenContent: () => string | null
    snapshotFor: (contentId: string) => Snapshot | undefined
  }
}

export function useWorkbench(): UseWorkbench {
  const ctx = useWorkbenchContext()
  // Short-circuit no-op reducers. Several reducers (e.g. `navigation.show`
  // when the content is already focused, `panes.assign` to the same content)
  // return the same state object reference. Without this guard, every such
  // call still propagates through `ctx.onChange` → consumer `setState` and
  // wakes the full set of downstream effects. Track 6's route mirror plus
  // route-intent receive plus auto-open-project re-enter on each wake; with
  // a stale URL on the first cross-workspace click that re-entry forms a
  // reactive loop that overflows the Solid runUpdates stack. Skipping the
  // onChange when the next state is identity-equal to the current breaks
  // the loop without changing observable behavior.
  let scratch: WorkbenchState | undefined
  let clearQueued = false
  const queueScratchClear = () => {
    if (clearQueued) return
    clearQueued = true
    queueMicrotask(() => {
      scratch = undefined
      clearQueued = false
    })
  }

  const apply = (mut: (s: WorkbenchState) => WorkbenchState) => {
    const current = scratch ?? ctx.getState()
    const next = mut(current)
    if (next === current) return
    scratch = next
    queueScratchClear()
    ctx.onChange(next)
  }

  return {
    get state() {
      return ctx.getState()
    },
    contents: {
      add: (id) => apply((s) => reducers.contents.add(s, id)),
      remove: (id) => apply((s) => reducers.contents.remove(s, id)),
    },
    panes: {
      assign: (paneId, contentId) => apply((s) => reducers.panes.assign(s, paneId, contentId)),
    },
    split: {
      split: (targetPaneId, edge, contentId) =>
        apply((s) => reducers.split.split(s, targetPaneId, edge, contentId)),
      close: (paneId, opts) => apply((s) => reducers.split.close(s, paneId, opts ?? { destroyContent: false })),
      move: (contentId, fromPaneId, toPaneId) =>
        apply((s) => reducers.split.move(s, contentId, fromPaneId, toPaneId)),
      focus: (paneId) => apply((s) => reducers.split.focus(s, paneId)),
      resize: (path, ratio) => apply((s) => reducers.split.resize(s, path, ratio)),
    },
    navigation: {
      show: (contentId) => apply((s) => reducers.navigation.show(s, contentId)),
    },
    selectors: {
      aliveContents: () => pureSelectors.aliveContents(ctx.getState()),
      recentContents: () => pureSelectors.recentContents(ctx.getState()),
      contentPane: (id) => pureSelectors.contentPane(ctx.getState(), id),
      visiblePanes: () => pureSelectors.visiblePanes(ctx.getState()),
      paneRect: (id) => pureSelectors.paneRect(ctx.getState(), id),
      focusedContent: () => pureSelectors.focusedContent(ctx.getState()),
      mruHiddenContent: () => pureSelectors.mruHiddenContent(ctx.getState()),
      snapshotFor: (id) => pureSelectors.snapshotFor(ctx.getState(), id),
    },
  }
}
