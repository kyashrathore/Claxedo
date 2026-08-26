// <ClaxedoStateProvider> — composition of all state slices + the
// <WorkbenchProvider>. Exposes `useClaxedoState()` which returns the unified
// shape callers wire up to.

import { onCleanup, type Accessor } from "solid-js"
import type { JSX } from "@solidjs/web"
import { createStore, reconcile, type StoreSetter } from "solid-js"
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
import { createWorkspacePanelSlice, type WorkspacePanelSliceApi } from "./workspace-panel"
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
function sameStringArray(left: readonly string[], right: readonly string[]) {
  if (left === right) return true
  return left.length === right.length && left.every((item, index) => item === right[index])
}

function samePanes(left: readonly Pane[], right: readonly Pane[]) {
  if (left === right) return true
  return (
    left.length === right.length &&
    left.every((pane, index) => pane.id === right[index]?.id && pane.contentId === right[index]?.contentId)
  )
}

function sameSplitNode(left: SplitNode | undefined, right: SplitNode | undefined): boolean {
  if (!left || !right) return left === right
  if (left.t !== right.t) return false
  if (left.t === "leaf" && right.t === "leaf") return left.id === right.id
  if (left.t !== "split" || right.t !== "split") return false
  return (
    left.dir === right.dir &&
    left.size === right.size &&
    sameSplitNode(left.a, right.a) &&
    sameSplitNode(left.b, right.b)
  )
}

function sameSplit(left: SplitTree, right: SplitTree) {
  if (left === right) return true
  return (
    left.direction === right.direction &&
    left.sizes.length === right.sizes.length &&
    left.sizes.every((size, index) => size === right.sizes[index]) &&
    sameSplitNode(left.root, right.root)
  )
}

function sameSnapshot(left: Snapshot, right: Snapshot) {
  return (
    left.focusedPaneId === right.focusedPaneId &&
    samePanes(left.panes, right.panes) &&
    sameSplit(left.split, right.split)
  )
}

function sameSnapshots(left: Record<string, Snapshot>, right: Record<string, Snapshot>) {
  if (left === right) return true
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => !!right[key] && sameSnapshot(left[key]!, right[key]!))
  )
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

function loadInitialState(pathname?: string, availableContentTypes?: readonly string[]): ClaxedoState {
  const ls = safeStorage()
  if (!ls) return emptyClaxedoState()
  try {
    const raw = ls.getItem(STORAGE_KEY_V5)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      return initialStateForPath(validate(parsed, { availableContentTypes }).state, pathname ?? "")
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

function schedulePersistState(state: ClaxedoState): void {
  const win = typeof window === "undefined" ? undefined : (window as IdleWindow)
  if (!win) {
    persistState(state)
    return
  }
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
  const win = typeof window === "undefined" ? undefined : (window as IdleWindow)
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
  /** Surface types the active product composition can actually render. */
  availableContentTypes?: readonly string[]
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
  setState: StoreSetter<ClaxedoState>
  ready: Accessor<boolean>
}

/** Hook returning the composed state API. */
export const useClaxedoState = InnerCtx.use

function buildApi(props: InnerProps): ClaxedoStateApi {
  // InnerCtx creates this API once for a fixed store tuple. `createSimpleContext`
  // already invokes `init` untracked, so these reads neither subscribe nor trip
  // Solid 2's strict-read diagnostic.
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
  const initial =
    props.initialState ??
    loadInitialState(typeof window === "undefined" ? undefined : window.location.pathname, props.availableContentTypes)
  const [state, setState] = createStore<ClaxedoState>(initial)
  onCleanup(clearOpenSessions)
  // Rail hover and collapse are transient chrome: the hot-zone peek flips them
  // on every pointer pass. Persisting each flip rewrote the whole v5 blob and,
  // because scheduling cancels the pending timer first, a moving pointer could
  // starve a genuinely pending persist for as long as it kept moving. A write
  // that only moves `rail.hovered`/`rail.collapsed` therefore schedules no
  // persist of its own — the next real mutation carries their current values.
  //
  // Solid 2's setter takes a draft callback instead of Solid 1's
  // `(...path, value)` arguments, so the path a write targets is no longer
  // inspectable. The draft is read-your-writes (see `@/lib/store-draft`), so the
  // same policy is expressed by comparing those two fields across the write.
  // Every rail write is a single-path `storePath("rail", ...)` call, so a change
  // to either field identifies the write.
  const setPersistentState: StoreSetter<ClaxedoState> = (update) => {
    let railTransientOnly = false
    setState(($state) => {
      const hovered = $state.rail.hovered
      const collapsed = $state.rail.collapsed
      const replacement = update($state)
      if (replacement !== undefined) return replacement
      railTransientOnly = $state.rail.hovered !== hovered || $state.rail.collapsed !== collapsed
    })
    if (!railTransientOnly) schedulePersistState(state)
  }
  if (typeof window !== "undefined") {
    const flush = () => flushPersistState(state)
    window.addEventListener("pagehide", flush)
    onCleanup(() => window.removeEventListener("pagehide", flush))
  }

  // Controlled WorkbenchProvider — pipe state.workbench through.
  const wbState = {
    get current(): WorkbenchState {
      return state.workbench
    },
  }
  const wbOnChange = (next: WorkbenchState) => {
    // Read the CURRENT workbench off the draft, not off `state`: Solid 2 stages
    // store writes until the scheduler flushes, and one gesture can chain
    // several reducers within a task (`openSession` = `contents.add` +
    // `navigation.show`). Comparing against the committed value would diff the
    // second write against the pre-burst base and could skip a slice the first
    // write already staged.
    let patched = false
    setState(($state) => {
      const current = $state.workbench
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
      )
        return

      patched = true
      // Reducers return an immutable WorkbenchState, but the application owns a
      // fine-grained Solid store. Reconciling the whole WorkbenchState on every
      // reducer result made a one-pane session focus walk contentIds, every
      // layout snapshot, the split tree, and every pane. Apply only the changed
      // top-level slices instead. `reconcile` is still used where identity is
      // meaningful (pane rows are keyed by id), so a focus keeps the pane DOM
      // and all unrelated store nodes alive.
      markRendererPhase("sessionActivate.patchStart")
      measureRendererPhase("workbench.patch", () => {
        if (focusedPaneChanged) current.focusedPaneId = next.focusedPaneId
        if (panesChanged) reconcile(next.panes, "id")(current.panes)
        if (splitChanged) reconcile(next.split)(current.split)
        // A path setter aimed at an array invokes Solid Store's `updateArray`,
        // which rewrites every changed index. Moving a tab from the tail of a
        // large MRU list to the front therefore emitted
        // O(number-of-open-surfaces) signals during every focus. These arrays
        // have value semantics, so replace them as object properties: one
        // parent signal per changed collection, with the complete canonical
        // order still delivered synchronously to consumers.
        if (contentIdsChanged) current.contentIds = next.contentIds
        if (contentRecencyChanged) current.contentRecency = next.contentRecency
        if (snapshotsChanged) reconcile(next.layoutSnapshots)(current.layoutSnapshots)
      })
      markRendererPhase("sessionActivate.patchEnd")
    })
    if (patched) schedulePersistState(state)
  }
  const ready = props.ready ?? (() => true)

  return (
    <WorkbenchProvider state={wbState} onChange={wbOnChange}>
      <InnerCtx.provider state={state} setState={setPersistentState} ready={ready}>
        {props.children}
      </InnerCtx.provider>
    </WorkbenchProvider>
  )
}

export type { ClaxedoState, WorkspacePanelState }
