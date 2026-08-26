export type WorkspacePanelNavigator = "files" | "changes" | "processes"
/**
 * Mode the workspace panel is rendering in. The active mode picks the
 * top-level body component inside `WorkspacePanel`. Workspace-scoped modes
 * (Files / Review / Processes / Activity) bind to a workspace directory; the
 * `workgraph-*` modes are global-navigation surfaces that are NOT bound to any
 * workspace and render their own contributed views via the panel slot.
 */
export type WorkspacePanelMode =
  | "files"
  | "review"
  | "processes"
  | "activity"
  | "workgraph-attention"
  | "workgraph-settings"
  | "workgraph-tasks"

export type GlobalPanelMode = "workgraph-attention" | "workgraph-settings" | "workgraph-tasks"

/**
 * A global-navigation panel mode is not bound to a workspace directory. These
 * bypass every workspace-target requirement (open gate, body directory, focus
 * retargeting) because the active global surface owns the panel content.
 */
export function isGlobalPanelMode(mode: WorkspacePanelMode | undefined): mode is GlobalPanelMode {
  return mode === "workgraph-attention" || mode === "workgraph-settings" || mode === "workgraph-tasks"
}
// File focus intent — set by the navigator based on which mode the file
// tree is in. "tab" opens the file as a workspace tab; "review" scrolls
// to the file's diff in the review tab.
export type FileFocusIntent = "tab" | "review"
export type WorkspacePanelFocus =
  | { kind: "file"; path: string; version: number; intent: FileFocusIntent; line?: number; col?: number }
  | { kind: "browser"; url: string; version: number }
  | { kind: "process"; processId: string; version: number }
  | { kind: "context"; sessionId: string; version: number }
export type WorkspacePanelFocusTarget =
  | { kind: "file"; path: string; intent: FileFocusIntent; line?: number; col?: number }
  | { kind: "browser"; url: string }
  | { kind: "process"; processId: string }
  | { kind: "context"; sessionId: string }
export type WorkspacePanelActivityTarget = {
  subjectType: string
  subjectId: string
  label?: string
}
// Backwards-compat alias — kept so existing call sites that read
// `state.activitySubject` still type-check; in cycle 24 we removed
// the auto-incrementing version field per the test contract.
export type WorkspacePanelActivitySubject = WorkspacePanelActivityTarget

export type WorkspacePanelState = {
  open: boolean
  mode?: WorkspacePanelMode
  workspaceDir?: string
  targetPaneId?: string
  navigator?: WorkspacePanelNavigator
  navigatorHidden?: boolean
  focus?: WorkspacePanelFocus
  activitySubject?: WorkspacePanelActivitySubject
}

export type WorkspacePanelTarget = {
  mode?: WorkspacePanelMode
  workspaceDir?: string
  targetPaneId?: string
  navigator?: WorkspacePanelNavigator | null
  focus?: WorkspacePanelFocusTarget | null
  activitySubject?: WorkspacePanelActivityTarget | null
}

export type WorkspacePanelPaneTarget = {
  workspaceDir: string
  targetPaneId: string
}

export function createWorkspacePanel(): WorkspacePanelState {
  return {
    open: false,
  }
}

function nextNavigator(state: WorkspacePanelState, input: WorkspacePanelTarget) {
  if ("navigator" in input) return input.navigator ?? undefined
  // Files / Changes / Processes is a panel presentation choice, not
  // workspace-owned data. Retargeting an already-open panel to the session's
  // destination workspace must keep that choice while the keyed body replaces
  // its directory-scoped providers. Clearing it here made an across-workspace
  // session click silently change Files back to Review.
  return state.navigator
}

function nextFocus(state: WorkspacePanelState, input: WorkspacePanelTarget) {
  if ("focus" in input) {
    if (!input.focus) return undefined
    return {
      ...input.focus,
      version: (state.focus?.version ?? 0) + 1,
    }
  }
  if (input.workspaceDir && input.workspaceDir !== state.workspaceDir) return undefined
  return state.focus
}

function nextActivitySubject(state: WorkspacePanelState, input: WorkspacePanelTarget) {
  if ("activitySubject" in input) {
    if (!input.activitySubject) return undefined
    // The test contract carries the bare target through; no version
    // field is added (the activity body re-renders on subjectId
    // change, so version-bumping was redundant noise).
    return { ...input.activitySubject }
  }
  return undefined
}

export function openWorkspacePanel(
  state: WorkspacePanelState,
  input: WorkspacePanelTarget,
): WorkspacePanelState {
  // A workspace-scoped focus (file/process/context) is consumed by the
  // workspace panel body, which never mounts under a global mode. Without this
  // fallback, opening a file link while a global surface is showing silently
  // swallowed the click (and then popped a surprise tab when the user later
  // left global mode).
  const keptMode =
    isGlobalPanelMode(state.mode) && input.focus ? undefined : state.mode
  return {
    ...state,
    open: true,
    mode: input.mode ?? keptMode ?? "review",
    workspaceDir: input.workspaceDir,
    targetPaneId: input.targetPaneId,
    navigator: nextNavigator(state, input),
    focus: nextFocus(state, input),
    activitySubject: nextActivitySubject(state, input),
  }
}

export function retargetWorkspacePanel(state: WorkspacePanelState, input: WorkspacePanelTarget): WorkspacePanelState {
  return {
    ...state,
    mode: input.mode ?? state.mode,
    workspaceDir: input.workspaceDir,
    targetPaneId: input.targetPaneId,
    navigator: nextNavigator(state, input),
    focus: nextFocus(state, input),
    activitySubject: nextActivitySubject(state, input),
  }
}

export function shouldRetargetWorkspacePanelForFocusedPane(
  state: WorkspacePanelState,
  previous: WorkspacePanelPaneTarget | undefined,
  next: WorkspacePanelPaneTarget | undefined,
) {
  if (!state.open || !state.mode || !previous || !next) return false
  if (state.workspaceDir !== previous.workspaceDir || state.targetPaneId !== previous.targetPaneId) return false
  return state.workspaceDir !== next.workspaceDir || state.targetPaneId !== next.targetPaneId
}

export function closeWorkspacePanel(state: WorkspacePanelState): WorkspacePanelState {
  if (!state.open) return state
  return {
    ...state,
    open: false,
  }
}
