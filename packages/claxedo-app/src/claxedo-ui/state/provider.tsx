// <ClaxedoStateProvider> — composition of all state slices + the
// <WorkbenchProvider>. Exposes `useClaxedoState()` which returns the unified
// shape callers wire up to.

import { createEffect, on, type Accessor, type JSX } from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import {
  WorkbenchProvider,
  useWorkbench,
  type UseWorkbench,
  type WorkbenchState,
} from "../layout"
import type {
  WorkspacePanelState,
  WorkspacePanelTarget,
} from "../workspace-panel/workspace-panel-state"
import { createMetadataSlice, type MetadataSliceApi } from "./metadata"
import { createTerminalSlice, type TerminalSliceApi } from "./terminal"
import { createWorkspaceSlice, type WorkspaceSliceApi } from "./workspace"
import { createRailSlice, type RailSliceApi } from "./rail"
import { createWorkspacePanelSlice, type WorkspacePanelSliceApi } from "./workspace-panel"
import { createProcessPaneSlice, type ProcessPaneSliceApi } from "./process-pane"
import { createLayoutOrchestration, type LayoutOrchestrationApi } from "./orchestration"
import { emptyClaxedoState, validate } from "./persistence"
import type { ClaxedoState } from "./types"

const STORAGE_KEY_V5 = "claxedo.state.v5"

const safeStorage = (): Storage | undefined => {
  try {
    if (typeof window === "undefined") return undefined
    return window.localStorage
  } catch {
    return undefined
  }
}

function loadInitialState(): ClaxedoState {
  const ls = safeStorage()
  if (!ls) return emptyClaxedoState()
  try {
    const raw = ls.getItem(STORAGE_KEY_V5)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      return validate(parsed).state
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

  const meta = createMetadataSlice({ state, setState })
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
  const initial = props.initialState ?? loadInitialState()
  const [state, setState] = createStore<ClaxedoState>(initial)

  // Persist on every state change. `persistState` stringifies the store, which
  // reads nested keys and therefore tracks more than just top-level slice
  // references.
  createEffect(
    on(
      () => JSON.stringify(state),
      () => persistState(state),
      { defer: true },
    ),
  )

  // Controlled WorkbenchProvider — pipe state.workbench through.
  const wbState = (): WorkbenchState => state.workbench
  const wbOnChange = (next: WorkbenchState) => {
    setState("workbench", next)
    persistState({ ...state, workbench: next })
  }
  const ready = props.ready ?? (() => true)

  return (
    <WorkbenchProvider state={wbState() as WorkbenchState} onChange={wbOnChange}>
      <InnerCtx.provider state={state} setState={setState} ready={ready}>
        {props.children}
      </InnerCtx.provider>
    </WorkbenchProvider>
  )
}

export type { ClaxedoState, WorkspacePanelState }
