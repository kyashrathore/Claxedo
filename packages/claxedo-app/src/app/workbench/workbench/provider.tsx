import { createContext, createMemo, useContext } from "solid-js"
import type { JSX } from "@solidjs/web"
import type { Pane, Snapshot, WorkbenchState, Edge, PaneRect } from "./types"
import { reducers } from "./reducers/index"
import { selectors as pureSelectors } from "./selectors"

export type WorkbenchProviderProps = {
  state: { readonly current: WorkbenchState }
  onChange: (next: WorkbenchState) => void
  children: JSX.Element
}

type WorkbenchContextValue = {
  getState: () => WorkbenchState
  onChange: (next: WorkbenchState) => void
}

const WorkbenchContext = createContext<WorkbenchContextValue | null>(null)

export function WorkbenchProvider(props: WorkbenchProviderProps): JSX.Element {
  // The consumer-owned store is the single authoritative copy; reads go
  // straight to it and writes go straight back through `onChange`. Same-task
  // read-after-write consistency for chained mutations is owned in one place:
  // the scratch cache inside `useWorkbench().apply` (staged store writes only
  // commit on the scheduler microtask, so chained reducers would otherwise
  // compute off the same stale base and lose every write but the last).
  const value: WorkbenchContextValue = {
    getState: () => props.state.current,
    onChange: (next) => props.onChange(next),
  }
  return <WorkbenchContext value={value}>{props.children}</WorkbenchContext>
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
    open: (contentId: string, focus?: boolean) => void
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
  // Focus is a global projection consumed by the route bridge, rail, header,
  // panel targeting, and session actions. Computing the selector inline made
  // each consumer independently scan `panes` and subscribe to every pane row.
  // One memo owns that scan and fans out only the scalar content-id change.
  const focusedContent = createMemo(() => pureSelectors.focusedContent(ctx.getState()))
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
      open: (id, focus = true) =>
        apply((s) => {
          const added = reducers.contents.add(s, id)
          return focus ? reducers.navigation.show(added, id) : added
        }),
      remove: (id) => apply((s) => reducers.contents.remove(s, id)),
    },
    panes: {
      assign: (paneId, contentId) => apply((s) => reducers.panes.assign(s, paneId, contentId)),
    },
    split: {
      split: (targetPaneId, edge, contentId) => apply((s) => reducers.split.split(s, targetPaneId, edge, contentId)),
      close: (paneId, opts) => apply((s) => reducers.split.close(s, paneId, opts ?? { destroyContent: false })),
      move: (contentId, fromPaneId, toPaneId) => apply((s) => reducers.split.move(s, contentId, fromPaneId, toPaneId)),
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
      focusedContent,
      mruHiddenContent: () => pureSelectors.mruHiddenContent(ctx.getState()),
      snapshotFor: (id) => pureSelectors.snapshotFor(ctx.getState(), id),
    },
  }
}
