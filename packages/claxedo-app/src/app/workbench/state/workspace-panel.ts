// Workspace-panel slice — wraps the existing pure helpers in
// `workspace-panel/workspace-panel-state.ts` (which we keep, since they are
// already pure data transitions). This slice gives the orchestration layer a
// minimal facade that owns the live state.

import { batch, type Accessor } from "solid-js"
import type { SetStoreFunction } from "solid-js/store"
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
import type { ClaxedoState } from "./types"

// Call sites use two equivalent shapes:
//   - `open({ mode: "review", workspaceDir, ... })`   (target-only)
//   - `open("review", { workspaceDir, ... })`         (mode-then-target)
// The slice accepts both and merges them into a single
// `WorkspacePanelTarget`. Without this, the mode-first form silently
// dropped the target object (because `"review"` got bound as `target`),
// which is why the L2 trio buttons in `L2HeaderStrip` looked dead.
type OpenArgs =
  | [target?: WorkspacePanelTarget]
  | [mode: WorkspacePanelMode, target?: WorkspacePanelTarget]

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
  if (left.kind === "file" && right.kind === "file") return left.path === right.path && left.intent === right.intent
  if (left.kind === "process" && right.kind === "process") return left.processId === right.processId
  return left.kind === "context" && right.kind === "context" && left.sessionId === right.sessionId
}

function sameActivitySubject(
  left: WorkspacePanelActivitySubject | undefined,
  right: WorkspacePanelActivitySubject | undefined,
) {
  if (!left || !right) return left === right
  return left.subjectType === right.subjectType &&
    left.subjectId === right.subjectId &&
    left.label === right.label
}

function samePanelState(current: WorkspacePanelState, next: WorkspacePanelState) {
  const patch = panelPatch(current, next)
  return !patch.open &&
    !patch.mode &&
    !patch.workspaceDir &&
    !patch.targetPaneId &&
    !patch.navigator &&
    !patch.navigatorHidden &&
    !patch.focus &&
    !patch.activitySubject
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
  setState: SetStoreFunction<ClaxedoState>
  /** Resolves the natural target for an open call when the caller doesn't pass one. */
  defaultTarget: () => WorkspacePanelTarget
}): WorkspacePanelSliceApi {
  const { state, setState, defaultTarget } = input

  // Per-provider-instance (a second ClaxedoStateProvider mount no longer shares
  // and cross-contaminates snapshots) and bounded (see MAX_SESSION_PANEL_SNAPSHOTS).
  const sessionPanelSnapshots = new Map<string, WorkspacePanelState>()
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

  const accessor: Accessor<WorkspacePanelState> = () => state.workspacePanel
  const resolvedTarget = (target: WorkspacePanelTarget) =>
    target.workspaceDir !== undefined && target.targetPaneId !== undefined
      ? target
      : { ...defaultTarget(), ...target }
  const replacePanel = (next: WorkspacePanelState) => {
    if (samePanelState(state.workspacePanel, next)) return
    setState("workspacePanel", next)
  }

  return {
    state: accessor,
    open(...args) {
      const target = normalizeArgs(args)
      const next = openWorkspacePanel(state.workspacePanel, resolvedTarget(target))
      const patch = panelPatch(state.workspacePanel, next)
      batch(() => {
        if (patch.open) setState("workspacePanel", "open", next.open)
        if (patch.mode) setState("workspacePanel", "mode", next.mode)
        if (patch.workspaceDir) setState("workspacePanel", "workspaceDir", next.workspaceDir)
        if (patch.targetPaneId) setState("workspacePanel", "targetPaneId", next.targetPaneId)
        if (patch.navigator) setState("workspacePanel", "navigator", next.navigator)
        if (patch.navigatorHidden) setState("workspacePanel", "navigatorHidden", next.navigatorHidden)
        if (patch.focus) setState("workspacePanel", "focus", next.focus)
        if (patch.activitySubject) setState("workspacePanel", "activitySubject", next.activitySubject)
      })
    },
    close() {
      if (!state.workspacePanel.open) return
      setState("workspacePanel", "open", closeWorkspacePanel(state.workspacePanel).open)
    },
    toggle(...args) {
      const target = normalizeArgs(args)
      const current = state.workspacePanel
      const next = resolvedTarget(target)
      const requestedNavigator = "navigator" in target ? next.navigator : current.navigator
      const changingFocus = "focus" in target
      const changingActivity = "activitySubject" in target
      const requestedMode = "mode" in target ? next.mode : current.mode
      if (
        current.open &&
        current.workspaceDir === next.workspaceDir &&
        current.navigator === requestedNavigator &&
        current.mode === requestedMode &&
        !changingFocus &&
        !changingActivity
      ) {
        replacePanel(closeWorkspacePanel(current))
        return
      }
      replacePanel(openWorkspacePanel(current, next))
    },
    retarget(target) {
      replacePanel(retargetWorkspacePanel(state.workspacePanel, resolvedTarget(target ?? {})))
    },
    rememberSession(sessionId) {
      if (!usableSessionId(sessionId)) return
      touchSnapshot(sessionId, snapshotPanel(state.workspacePanel))
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
      const current = state.workspacePanel
      // If the panel is closed, opening into the selected mode uses the
      // default target (directory + pane) so the panel mounts in the
      // right scope. If it's open, switch the active mode in place
      // without disturbing dir/pane/navigator/focus.
      if (!current.open) {
        replacePanel(openWorkspacePanel(current, { ...defaultTarget(), mode }))
        return
      }
      // Just patch `mode` directly — using `retargetWorkspacePanel`
      // here would clobber `workspaceDir`/`targetPaneId` with undefined.
      if (current.mode === mode) return
      setState("workspacePanel", "mode", mode)
    },
    setNavigatorHidden(hidden) {
      if (state.workspacePanel.navigatorHidden === hidden) return
      setState("workspacePanel", "navigatorHidden", hidden)
    },
  }
}
