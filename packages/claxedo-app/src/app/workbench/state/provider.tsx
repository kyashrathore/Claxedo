// <ClaxedoStateProvider> — composition of all state slices + the
// <WorkbenchProvider>. Exposes `useClaxedoState()` which returns the unified
// shape callers wire up to.

import { batch, createEffect, onCleanup, type Accessor, type JSX } from "solid-js"
import { createStore, reconcile, type SetStoreFunction } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import {
  WorkbenchProvider,
  useWorkbench,
  type UseWorkbench,
  type Pane,
  type Snapshot,
  type SplitNode,
  type SplitTree,
  type WorkbenchState,
} from "../workbench/index"
import type {
  WorkspacePanelState,
  WorkspacePanelTarget,
} from "../../../features/workspaces/ui/panel/workspace-panel-state"
import { createMetadataSlice, type MetadataSliceApi } from "./metadata"
import { markRendererPhase, measureRendererPhase } from "@/platform/performance/renderer-trace"
import { createTerminalSlice, type TerminalSliceApi } from "./terminal"
import { createWorkspaceSlice, type WorkspaceSliceApi } from "./workspace"
import { createRailSlice, type RailSliceApi } from "./rail"
import { createWorkspacePanelSlice, syncFocusedSessionPanel, type WorkspacePanelSliceApi } from "./workspace-panel"
import { createProcessPaneSlice, type ProcessPaneSliceApi } from "@/features/processes/state"
import { createLayoutOrchestration, type LayoutOrchestrationApi } from "./orchestration"
import { emptyClaxedoState, validate } from "./persistence"
import type { ClaxedoState, ContentMeta } from "./types"
import { parseShellRoute } from "@/platform/identity/route"
import {
  clearOpenSessions,
  setOpenSessionMeta,
  setOpenSessionMetas,
} from "../../../features/session/store/open-sessions"

const STORAGE_KEY_V5 = "claxedo.state.v5"
type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number
  cancelIdleCallback?: (handle: number) => void
}
type StoreSetter = (...args: unknown[]) => unknown

function sameStringArray(left: readonly string[], right: readonly string[]) {
  if (left === right) return true
  return left.length === right.length && left.every((item, index) => item === right[index])
}

function samePanes(left: readonly Pane[], right: readonly Pane[]) {
  if (left === right) return true
  return left.length === right.length &&
    left.every((pane, index) => pane.id === right[index]?.id && pane.contentId === right[index]?.contentId)
}

function sameSplitNode(left: SplitNode | undefined, right: SplitNode | undefined): boolean {
  if (!left || !right) return left === right
  if (left.t !== right.t) return false
  if (left.t === "leaf" && right.t === "leaf") return left.id === right.id
  if (left.t !== "split" || right.t !== "split") return false
  return left.dir === right.dir &&
    left.size === right.size &&
    sameSplitNode(left.a, right.a) &&
    sameSplitNode(left.b, right.b)
}

function sameSplit(left: SplitTree, right: SplitTree) {
  if (left === right) return true
  return left.direction === right.direction &&
    left.sizes.length === right.sizes.length &&
    left.sizes.every((size, index) => size === right.sizes[index]) &&
    sameSplitNode(left.root, right.root)
}

function sameSnapshot(left: Snapshot, right: Snapshot) {
  return left.focusedPaneId === right.focusedPaneId &&
    samePanes(left.panes, right.panes) &&
    sameSplit(left.split, right.split)
}

function sameSnapshots(left: Record<string, Snapshot>, right: Record<string, Snapshot>) {
  if (left === right) return true
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => !!right[key] && sameSnapshot(left[key]!, right[key]!))
}

const safeStorage = (): Storage | undefined => {
  try {
    if (typeof window === "undefined") return undefined
    return window.localStorage
  } catch {
    return undefined
  }
}

export function routeOwnsInitialSurface(pathname: string) {
  const route = parseShellRoute(pathname)
  if (route.kind === "session") return true
  if (route.kind === "workspace-session") return true
  if (route.kind === "workspace-page") return true
  if (route.kind === "workspace-terminal") return true
  return route.kind === "legacy-directory" && (!!route.sessionId || !!route.pageId || !!route.terminalId)
}

/**
 * Whether route reconciliation, rather than the empty-workbench fallback,
 * materializes the first visible surface.
 *
 * This is deliberately broader than `routeOwnsInitialSurface`: that predicate
 * decides whether persisted panes must be discarded, while this one only
 * prevents a competing draft from being opened during route reconciliation.
 * A legacy `/<directory>/session` route, WorkGraph, and Marketplace all keep
 * persisted panes, but each still owns what should become visible on boot.
 */
export function routeSuppressesEmptyDraftSession(pathname: string) {
  const kind = parseShellRoute(pathname).kind
  return kind !== "home" && kind !== "unknown"
}

export function initialStateForPath(state: ClaxedoState, pathname: string) {
  if (!routeOwnsInitialSurface(pathname)) return state
  const empty = emptyClaxedoState()
  return {
    ...state,
    workbench: empty.workbench,
    meta: empty.meta,
    terminal: empty.terminal,
    workspacePanel: empty.workspacePanel,
    processPane: empty.processPane,
  }
}

function loadInitialState(pathname?: string): ClaxedoState {
  const ls = safeStorage()
  if (!ls) return emptyClaxedoState()
  try {
    const raw = ls.getItem(STORAGE_KEY_V5)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      return initialStateForPath(validate(parsed).state, pathname ?? "")
    }
  } catch {
    // fall through
  }
  return emptyClaxedoState()
}

function persistState(state: ClaxedoState): void {
  const ls = safeStorage()
  if (!ls) return
  try {
    ls.setItem(STORAGE_KEY_V5, JSON.stringify(state))
  } catch {
    // Storage quota / DOMException — silently drop. The next save will retry.
  }
}

let pendingPersist: number | undefined
let pendingPersistKind: "idle" | "timeout" | undefined

function cancelPendingPersist(win: IdleWindow): void {
  if (pendingPersist === undefined) return
  if (pendingPersistKind === "idle" && win.cancelIdleCallback) win.cancelIdleCallback(pendingPersist)
  else win.clearTimeout(pendingPersist)
  pendingPersist = undefined
  pendingPersistKind = undefined
}

function shouldSkipPersist(args: unknown[]) {
  if (args[0] !== "rail") return false
  return args[1] === "hovered" || args[1] === "collapsed"
}

function schedulePersistState(state: ClaxedoState, args: unknown[]): void {
  const win = typeof window === "undefined" ? undefined : window as IdleWindow
  if (!win) {
    persistState(state)
    return
  }
  if (shouldSkipPersist(args)) return
  cancelPendingPersist(win)
  const flush = () => {
    pendingPersist = undefined
    pendingPersistKind = undefined
    persistState(state)
  }
  pendingPersistKind = "timeout"
  pendingPersist = win.setTimeout(() => {
    pendingPersist = undefined
    pendingPersistKind = undefined
    if (win.requestIdleCallback) {
      pendingPersistKind = "idle"
      pendingPersist = win.requestIdleCallback(flush, { timeout: 250 })
      return
    }
    flush()
  }, 100)
}

function flushPersistState(state: ClaxedoState): void {
  const win = typeof window === "undefined" ? undefined : window as IdleWindow
  if (win) cancelPendingPersist(win)
  else pendingPersist = undefined
  pendingPersistKind = undefined
  persistState(state)
}

export type ClaxedoStateApi = {
  /** Workbench hook (panes, splits, focus, contents, navigation). */
  wb: UseWorkbench
  meta: MetadataSliceApi
  terminal: TerminalSliceApi
  workspace: WorkspaceSliceApi
  rail: RailSliceApi
  workspacePanel: WorkspacePanelSliceApi
  processPane: ProcessPaneSliceApi
  layout: LayoutOrchestrationApi
  /** Reactive readiness flag — `true` once the persisted state has hydrated. */
  ready: Accessor<boolean>
  /** Direct read access for slice authors / tests. */
  state: ClaxedoState
}

export type ClaxedoStateProviderProps = {
  /** Optional initial state — caller is responsible for validation. */
  initialState?: ClaxedoState
  /** Optional readiness gate — defaults to `() => true`. */
  ready?: Accessor<boolean>
  children: JSX.Element
}

// Inner context: lives below <WorkbenchProvider> so useWorkbench() works.
const InnerCtx = createSimpleContext<ClaxedoStateApi, InnerProps>({
  name: "ClaxedoState",
  init: (props) => buildApi(props),
  gate: false,
})

type InnerProps = {
  state: ClaxedoState
  setState: SetStoreFunction<ClaxedoState>
  ready: Accessor<boolean>
}

/** Hook returning the composed state API. */
export const useClaxedoState = InnerCtx.use

function buildApi(props: InnerProps): ClaxedoStateApi {
  const { state, setState, ready } = props
  const wb = useWorkbench()

  setOpenSessionMetas(Object.values(state.meta).filter((meta): meta is ContentMeta => !!meta))
  const meta = createMetadataSlice({
    state,
    setState,
    onChange: ({ id, next }) => setOpenSessionMeta(id, next),
  })
  const terminal = createTerminalSlice({ state, setState })
  const workspace = createWorkspaceSlice({ state, setState })
  const rail = createRailSlice({ state, setState })
  const processPane = createProcessPaneSlice({ state, setState })

  const defaultPanelTarget = (): WorkspacePanelTarget => {
    const paneId = wb.state.focusedPaneId ?? null
    const focusedPane = paneId ? wb.state.panes.find((p) => p.id === paneId) : undefined
    const contentId = focusedPane?.contentId ?? null
    const m = contentId ? meta.get(contentId) : undefined
    if (m?.directory) return { workspaceDir: m.directory, targetPaneId: paneId ?? undefined }
    if (paneId) {
      const wt = workspace.paneWorktree(paneId)
      const dir = wt.pinned ?? wt.default ?? undefined
      if (dir) return { workspaceDir: dir, targetPaneId: paneId }
    }
    return { workspaceDir: undefined, targetPaneId: paneId ?? undefined }
  }
  const workspacePanel = createWorkspacePanelSlice({
    state,
    setState,
    defaultTarget: defaultPanelTarget,
  })

  const focusedSessionId = (): string | undefined => {
    const contentId = wb.selectors.focusedContent()
    const focused = contentId ? meta.get(contentId) : undefined
    if (focused?.type !== "session") return
    const id = focused.sessionId
    return id && id !== "new" ? id : undefined
  }
  // Owns remember/restore for every focus change (rail click, URL, command,
  // tab). Rail used to snapshot after `onSessionSelect` had already focused
  // the destination, so every session inherited the last open panel.
  createEffect((previous: { id: string | undefined } | undefined) => {
    const next = focusedSessionId()
    if (!previous) return { id: next }
    syncFocusedSessionPanel({
      previousSessionId: previous.id,
      nextSessionId: next,
      remember: (sessionId) => workspacePanel.rememberSession(sessionId),
      restore: (sessionId) => workspacePanel.restoreSession(sessionId, defaultPanelTarget()),
    })
    return { id: next }
  })

  const layout = createLayoutOrchestration({ wb, meta, terminal })

  return {
    wb,
    meta,
    terminal,
    workspace,
    rail,
    workspacePanel,
    processPane,
    layout,
    ready,
    state,
  }
}

/** Provider — wraps `<WorkbenchProvider>` and exposes `useClaxedoState()`. */
export function ClaxedoStateProvider(props: ClaxedoStateProviderProps): JSX.Element {
  const initial = props.initialState ?? loadInitialState(
    typeof window === "undefined" ? undefined : window.location.pathname,
  )
  const [state, setState] = createStore<ClaxedoState>(initial)
  onCleanup(clearOpenSessions)
  // as-any: wraps Solid's overloaded setStore while preserving its public setter type.
  const rawSetState = setState as unknown as StoreSetter
  const setPersistentState = ((...args: unknown[]) => {
    const result = rawSetState(...args)
    schedulePersistState(state, args)
    return result
    // as-any: wrapper preserves Solid's overloaded SetStoreFunction call surface.
  }) as unknown as SetStoreFunction<ClaxedoState>
  if (typeof window !== "undefined") {
    const flush = () => flushPersistState(state)
    window.addEventListener("pagehide", flush)
    onCleanup(() => window.removeEventListener("pagehide", flush))
  }

  // Controlled WorkbenchProvider — pipe state.workbench through.
  const wbState = (): WorkbenchState => state.workbench
  const wbOnChange = (next: WorkbenchState) => {
    const current = state.workbench
    const focusedPaneChanged = current.focusedPaneId !== next.focusedPaneId
    const panesChanged = !samePanes(current.panes, next.panes)
    const splitChanged = !sameSplit(current.split, next.split)
    const contentIdsChanged = !sameStringArray(current.contentIds, next.contentIds)
    const contentRecencyChanged = !sameStringArray(current.contentRecency, next.contentRecency)
    const snapshotsChanged = !sameSnapshots(current.layoutSnapshots, next.layoutSnapshots)
    if (
      !focusedPaneChanged &&
      !panesChanged &&
      !splitChanged &&
      !contentIdsChanged &&
      !contentRecencyChanged &&
      !snapshotsChanged
    ) return

    // Reducers return an immutable WorkbenchState, but the application owns a
    // fine-grained Solid store. Reconciling the whole WorkbenchState on every
    // reducer result made a one-pane session focus walk contentIds, every
    // layout snapshot, the split tree, and every pane. Apply only the changed
    // top-level slices instead. `reconcile` is still used where identity is
    // meaningful (pane rows are keyed by id), so a focus keeps the pane DOM
    // and all unrelated store nodes alive.
    markRendererPhase("sessionActivate.patchStart")
    measureRendererPhase("workbench.patch", () => {
      batch(() => {
        if (focusedPaneChanged) rawSetState("workbench", "focusedPaneId", next.focusedPaneId)
        if (panesChanged) rawSetState("workbench", "panes", reconcile(next.panes, { key: "id" }))
        if (splitChanged) rawSetState("workbench", "split", reconcile(next.split))
        if (contentIdsChanged || contentRecencyChanged) {
          // A path setter aimed at an array invokes Solid Store's
          // `updateArray`, which rewrites every changed index. Moving a tab
          // from the tail of a large MRU list to the front therefore emitted
          // O(number-of-open-surfaces) signals during every focus. These
          // arrays have value semantics, so replace them as object properties:
          // one parent signal per changed collection, with the complete
          // canonical order still delivered synchronously to consumers.
          const arrays: Partial<Pick<WorkbenchState, "contentIds" | "contentRecency">> = {}
          if (contentIdsChanged) arrays.contentIds = next.contentIds
          if (contentRecencyChanged) arrays.contentRecency = next.contentRecency
          rawSetState("workbench", arrays)
        }
        if (snapshotsChanged) {
          rawSetState("workbench", "layoutSnapshots", reconcile(next.layoutSnapshots))
        }
      })
      schedulePersistState(state, ["workbench"])
    })
    markRendererPhase("sessionActivate.patchEnd")
  }
  const ready = props.ready ?? (() => true)

  return (
    <WorkbenchProvider state={wbState()} onChange={wbOnChange}>
      <InnerCtx.provider state={state} setState={setPersistentState} ready={ready}>
        {props.children}
      </InnerCtx.provider>
    </WorkbenchProvider>
  )
}

export type { ClaxedoState, WorkspacePanelState }
