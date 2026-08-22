// <ClaxedoStateProvider> — composition of all state slices + the
// <WorkbenchProvider>. Exposes `useClaxedoState()` which returns the unified
// shape callers wire up to.

import { onCleanup, type Accessor, type JSX } from "solid-js"
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
import { createTerminalSlice, type TerminalSliceApi } from "./terminal"
import { createWorkspaceSlice, type WorkspaceSliceApi } from "./workspace"
import { createRailSlice, type RailSliceApi } from "./rail"
import { createWorkspacePanelSlice, type WorkspacePanelSliceApi } from "./workspace-panel"
import { createProcessPaneSlice, type ProcessPaneSliceApi } from "@/features/processes/state"
import { createLayoutOrchestration, type LayoutOrchestrationApi } from "./orchestration"
import { emptyClaxedoState, validate } from "./persistence"
import type { ClaxedoState } from "./types"
import { parseShellRoute } from "@/platform/identity/route"
import { clearOpenSessions, openSessionRefsFromMetas, setOpenSessions } from "../../../features/session/store/open-sessions"

const STORAGE_KEY_V5 = "claxedo.state.v5"
type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number
  cancelIdleCallback?: (handle: number) => void
}
type StoreSetter = (...args: unknown[]) => unknown

function sameStringArray(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

function samePanes(left: readonly Pane[], right: readonly Pane[]) {
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
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => !!right[key] && sameSnapshot(left[key]!, right[key]!))
}

function sameWorkbenchState(left: WorkbenchState, right: WorkbenchState) {
  return left.focusedPaneId === right.focusedPaneId &&
    samePanes(left.panes, right.panes) &&
    sameSplit(left.split, right.split) &&
    sameStringArray(left.contentIds, right.contentIds) &&
    sameStringArray(left.contentRecency, right.contentRecency) &&
    sameSnapshots(left.layoutSnapshots, right.layoutSnapshots)
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

  const meta = createMetadataSlice({
    state,
    setState,
    onChange: (metas) => setOpenSessions(openSessionRefsFromMetas(metas)),
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
    if (sameWorkbenchState(state.workbench, next)) return
    // `reconcile`, not a plain merge: every reducer returns brand-new
    // `panes`/`split`/`contentIds`/`contentRecency` references, so a plain
    // `setState("workbench", next)` replaces those store nodes wholesale on
    // EVERY mutation — each `navigation.show` invalidates every subscriber
    // under them (the workbench pane <For>s are keyed by pane object
    // reference and tear down/recreate their DOM; every `focusedContent()`
    // reader across the rail/route-bridge re-runs). Reconcile diffs into the
    // existing nodes (panes keyed by `id`), so only signals whose values
    // actually changed fire. The workbench test harness
    // (workbench/tests/dom-helpers.tsx) already drives the same reducers
    // through `reconcile` — this keeps production on the same contract.
    setPersistentState("workbench", reconcile(next, { key: "id" }))
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
