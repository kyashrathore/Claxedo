import { storePath } from "solid-js"
// Workspace-panel slice — wraps the existing pure helpers in
// `workspace-panel/workspace-panel-state.ts` (which we keep, since they are
// already pure data transitions). This slice gives the orchestration layer a
// minimal facade that owns the live state.

import { type Accessor } from "solid-js"
import type { StoreSetter } from "solid-js"
import {
  closeWorkspacePanel,
  openWorkspacePanel,
  retargetWorkspacePanel,
  type WorkspacePanelActivitySubject,
  type WorkspacePanelFocus,
  type WorkspacePanelMode,
  type WorkspacePanelState,
  type WorkspacePanelTarget,
} from "../../../features/workspaces/ui/panel/workspace-panel-state"
import {
  createReviewWorkspaceWorkingSetStore,
  type ReviewWorkspaceWorkingSetStore,
} from "../review/review-workspace-working-set"
import { createStagedValue } from "@/lib/staged-reads"
import type { ClaxedoState } from "./types"

// Call sites use two equivalent shapes:
//   - `open({ mode: "review", workspaceDir, ... })`   (target-only)
//   - `open("review", { workspaceDir, ... })`         (mode-then-target)
// The slice accepts both and merges them into a single
// `WorkspacePanelTarget`. Without this, the mode-first form silently
// dropped the target object (because `"review"` got bound as `target`),
// which is why the L2 trio buttons in `L2HeaderStrip` looked dead.
type OpenArgs = [target?: WorkspacePanelTarget] | [mode: WorkspacePanelMode, target?: WorkspacePanelTarget]

function normalizeArgs(args: OpenArgs): WorkspacePanelTarget {
  const head = args[0]
  if (typeof head === "string") {
    return { mode: head, ...args[1] }
  }
  return head ?? {}
}

function panelPatch(current: WorkspacePanelState, next: WorkspacePanelState) {
  return {
    open: next.open !== current.open,
    mode: next.mode !== current.mode,
    workspaceDir: next.workspaceDir !== current.workspaceDir,
    targetPaneId: next.targetPaneId !== current.targetPaneId,
    navigator: next.navigator !== current.navigator,
    navigatorHidden: next.navigatorHidden !== current.navigatorHidden,
    focus: !sameFocus(next.focus, current.focus),
    activitySubject: !sameActivitySubject(next.activitySubject, current.activitySubject),
  }
}

function sameFocus(left: WorkspacePanelFocus | undefined, right: WorkspacePanelFocus | undefined) {
  if (!left || !right) return left === right
  if (left.kind !== right.kind || left.version !== right.version) return false
  if (left.kind === "file" && right.kind === "file") {
    return (
      left.path === right.path && left.intent === right.intent && left.line === right.line && left.col === right.col
    )
  }
  if (left.kind === "browser" && right.kind === "browser") return left.url === right.url
  if (left.kind === "process" && right.kind === "process") return left.processId === right.processId
  return left.kind === "context" && right.kind === "context" && left.sessionId === right.sessionId
}

function sameActivitySubject(
  left: WorkspacePanelActivitySubject | undefined,
  right: WorkspacePanelActivitySubject | undefined,
) {
  if (!left || !right) return left === right
  return left.subjectType === right.subjectType && left.subjectId === right.subjectId && left.label === right.label
}

function samePanelState(current: WorkspacePanelState, next: WorkspacePanelState) {
  const patch = panelPatch(current, next)
  return (
    !patch.open &&
    !patch.mode &&
    !patch.workspaceDir &&
    !patch.targetPaneId &&
    !patch.navigator &&
    !patch.navigatorHidden &&
    !patch.focus &&
    !patch.activitySubject
  )
}

export type WorkspacePanelSliceApi = {
  state: Accessor<WorkspacePanelState>
  open(...args: OpenArgs): void
  close(): void
  toggle(...args: OpenArgs): void
  retarget(target?: WorkspacePanelTarget): void
  rememberSession(sessionId: string | undefined): void
  restoreSession(sessionId: string | undefined, target?: WorkspacePanelTarget): boolean
  /** Switch the active mode in place without re-opening or moving focus. */
  select(mode: WorkspacePanelMode): void
  setNavigatorHidden(hidden: boolean): void
  /**
   * Open the panel to a global-navigation mode that is NOT bound to any
   * workspace. Clears every workspace binding (dir/pane/navigator/focus) so the
   * active global surface owns the panel content. Used by WorkGraph.
   */
  openGlobal(mode: WorkspacePanelMode): void
  /** Toggle a global-navigation mode: closes if that exact mode is open, else opens it. */
  toggleGlobal(mode: WorkspacePanelMode): void
  /**
   * Retained Review working sets (tab DTOs, active tab, semantic Review
   * scroll), keyed by `reviewWorkspaceWorkingSetKey`.
   *
   * It lives on the slice, not inside the panel, because the panel body is
   * unmounted after the close motion so a closed Workspace owns zero DOM and
   * zero CPU. Reopen then reads its exact working set back from here. Snapshots
   * are small UI state only — never server payloads, loaders, or DOM — and the
   * store is non-reactive so restoring one cannot schedule global Solid work.
   */
  reviewWorkingSet: ReviewWorkspaceWorkingSetStore
}

/**
 * Upper bound on retained per-session panel snapshots. Snapshots live only to
 * restore panel layout when a user re-selects a session, so a bounded LRU is
 * ample. Without a cap this Map grew once per session opened for the entire
 * lifetime of a (long-running Electron) process — an unbounded leak.
 */
export const MAX_SESSION_PANEL_SNAPSHOTS = 64

function usableSessionId(sessionId: string | undefined): sessionId is string {
  return !!sessionId && sessionId !== "new"
}

function snapshotPanel(state: WorkspacePanelState): WorkspacePanelState {
  return {
    ...state,
    ...(state.focus ? { focus: { ...state.focus } } : {}),
    ...(state.activitySubject ? { activitySubject: { ...state.activitySubject } } : {}),
  }
}

export function createWorkspacePanelSlice(input: {
  state: ClaxedoState
  setState: StoreSetter<ClaxedoState>
  /** Resolves the natural target for an open call when the caller doesn't pass one. */
  defaultTarget: () => WorkspacePanelTarget
}): WorkspacePanelSliceApi {
  const { state, setState, defaultTarget } = input

  // Per-provider-instance (a second ClaxedoStateProvider mount no longer shares
  // and cross-contaminates snapshots) and bounded (see MAX_SESSION_PANEL_SNAPSHOTS).
  const sessionPanelSnapshots = new Map<string, WorkspacePanelState>()
  // Same provider-instance ownership as `sessionPanelSnapshots`, and bounded by
  // MAX_REVIEW_WORKSPACE_WORKING_SETS.
  const reviewWorkingSet = createReviewWorkspaceWorkingSetStore()
  const touchSnapshot = (sessionId: string, snapshot: WorkspacePanelState) => {
    // Re-insert so this key becomes the most-recent in insertion order (LRU).
    sessionPanelSnapshots.delete(sessionId)
    sessionPanelSnapshots.set(sessionId, snapshot)
    while (sessionPanelSnapshots.size > MAX_SESSION_PANEL_SNAPSHOTS) {
      const oldest = sessionPanelSnapshots.keys().next().value
      if (oldest === undefined) break
      sessionPanelSnapshots.delete(oldest)
    }
  }

  // Same-task read-your-writes. Solid 2 stages store writes until flush, and
  // every mutator here derives the next panel state from the current one
  // (open -> close -> rememberSession -> restoreSession all chain within a
  // task). Reading the committed snapshot each time rebuilt from a stale base
  // and silently dropped earlier calls. The shared overlay in
  // `@/lib/staged-reads` holds the last staged panel state; `current()` reads
  // the store first so reactive tracking through `accessor` is unchanged.
  const staged = createStagedValue<WorkspacePanelState>()
  const stagePanel = (next: WorkspacePanelState) => staged.stage(next)
  const current = (): WorkspacePanelState => staged.read(state.workspacePanel)

  const accessor: Accessor<WorkspacePanelState> = () => current()
  const resolvedTarget = (target: WorkspacePanelTarget) =>
    target.workspaceDir !== undefined && target.targetPaneId !== undefined ? target : { ...defaultTarget(), ...target }
  const replacePanel = (next: WorkspacePanelState) => {
    if (samePanelState(current(), next)) return
    stagePanel(next)
    setState(storePath("workspacePanel", next))
  }

  return {
    state: accessor,
    open(...args) {
      const target = normalizeArgs(args)
      const next = openWorkspacePanel(current(), resolvedTarget(target))
      const patch = panelPatch(current(), next)
      stagePanel(next)
      if (patch.open) setState(storePath("workspacePanel", "open", next.open))
      if (patch.mode) setState(storePath("workspacePanel", "mode", next.mode))
      if (patch.workspaceDir) setState(storePath("workspacePanel", "workspaceDir", next.workspaceDir))
      if (patch.targetPaneId) setState(storePath("workspacePanel", "targetPaneId", next.targetPaneId))
      if (patch.navigator) setState(storePath("workspacePanel", "navigator", next.navigator))
      if (patch.navigatorHidden) setState(storePath("workspacePanel", "navigatorHidden", next.navigatorHidden))
      if (patch.focus) setState(storePath("workspacePanel", "focus", next.focus))
      if (patch.activitySubject) setState(storePath("workspacePanel", "activitySubject", next.activitySubject))
    },
    close() {
      const panel = current()
      if (!panel.open) return
      const next = closeWorkspacePanel(panel)
      stagePanel(next)
      setState(storePath("workspacePanel", "open", next.open))
    },
    toggle(...args) {
      const target = normalizeArgs(args)
      const panel = current()
      const next = resolvedTarget(target)
      const requestedNavigator = "navigator" in target ? next.navigator : panel.navigator
      const changingFocus = "focus" in target
      const changingActivity = "activitySubject" in target
      const requestedMode = "mode" in target ? next.mode : panel.mode
      if (
        panel.open &&
        panel.workspaceDir === next.workspaceDir &&
        panel.navigator === requestedNavigator &&
        panel.mode === requestedMode &&
        !changingFocus &&
        !changingActivity
      ) {
        replacePanel(closeWorkspacePanel(panel))
        return
      }
      replacePanel(openWorkspacePanel(panel, next))
    },
    retarget(target) {
      replacePanel(retargetWorkspacePanel(current(), resolvedTarget(target ?? {})))
    },
    rememberSession(sessionId) {
      if (!usableSessionId(sessionId)) return
      touchSnapshot(sessionId, snapshotPanel(current()))
    },
    restoreSession(sessionId, target) {
      if (!usableSessionId(sessionId)) return false
      const snapshot = sessionPanelSnapshots.get(sessionId)
      if (!snapshot) return false
      // Mark as recently used so an active session isn't evicted first.
      touchSnapshot(sessionId, snapshot)
      const resolved = resolvedTarget(target ?? {})
      replacePanel({
        ...snapshotPanel(snapshot),
        workspaceDir: resolved.workspaceDir ?? snapshot.workspaceDir,
        targetPaneId: resolved.targetPaneId ?? snapshot.targetPaneId,
      })
      return true
    },
    select(mode) {
      const panel = current()
      // If the panel is closed, opening into the selected mode uses the
      // default target (directory + pane) so the panel mounts in the
      // right scope. If it's open, switch the active mode in place
      // without disturbing dir/pane/navigator/focus.
      if (!panel.open) {
        replacePanel(openWorkspacePanel(panel, { ...defaultTarget(), mode }))
        return
      }
      // Just patch `mode` directly — using `retargetWorkspacePanel`
      // here would clobber `workspaceDir`/`targetPaneId` with undefined.
      if (panel.mode === mode) return
      stagePanel({ ...panel, mode })
      setState(storePath("workspacePanel", "mode", mode))
    },
    setNavigatorHidden(hidden) {
      const panel = current()
      if (panel.navigatorHidden === hidden) return
      stagePanel({ ...panel, navigatorHidden: hidden })
      setState(storePath("workspacePanel", "navigatorHidden", hidden))
    },
    openGlobal(mode) {
      // Full replace, dropping any prior workspace binding: a global panel is
      // workspace-agnostic and its content is contributed by the active surface.
      replacePanel({ open: true, mode })
    },
    toggleGlobal(mode) {
      const panel = current()
      if (panel.open && panel.mode === mode) {
        replacePanel(closeWorkspacePanel(panel))
        return
      }
      replacePanel({ open: true, mode })
    },
    reviewWorkingSet,
  }
}
