export type WorkspacePanelMode = "files" | "changes" | "review" | "tasks" | "browser" | "processes"
export type WorkspacePanelNavigator = "files" | "processes"
// File focus intent — set by the navigator based on which mode the file
// tree is in. "tab" opens the file as a workspace tab; "review" scrolls
// to the file's diff in the review tab.
export type FileFocusIntent = "tab" | "review"
export type WorkspacePanelFocus =
  | { kind: "file"; path: string; version: number; intent: FileFocusIntent }
  | { kind: "process"; processId: string; version: number }
  | { kind: "context"; sessionId: string; version: number }
export type WorkspacePanelFocusTarget =
  | { kind: "file"; path: string; intent: FileFocusIntent }
  | { kind: "process"; processId: string }
  | { kind: "context"; sessionId: string }

export type WorkspacePanelState = {
  open: boolean
  mode?: WorkspacePanelMode
  workspaceDir?: string
  targetPaneId?: string
  navigator?: WorkspacePanelNavigator
  focus?: WorkspacePanelFocus
}

export type WorkspacePanelTarget = {
  workspaceDir?: string
  targetPaneId?: string
  navigator?: WorkspacePanelNavigator | null
  focus?: WorkspacePanelFocusTarget | null
}

export function createWorkspacePanel(): WorkspacePanelState {
  return {
    open: false,
  }
}

function nextNavigator(state: WorkspacePanelState, input: WorkspacePanelTarget) {
  if ("navigator" in input) return input.navigator ?? undefined
  if (input.workspaceDir && input.workspaceDir !== state.workspaceDir) return undefined
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

export function openWorkspacePanel(
  state: WorkspacePanelState,
  input: WorkspacePanelTarget & { mode: WorkspacePanelMode },
): WorkspacePanelState {
  return {
    ...state,
    open: true,
    mode: input.mode,
    workspaceDir: input.workspaceDir,
    targetPaneId: input.targetPaneId,
    navigator: nextNavigator(state, input),
    focus: nextFocus(state, input),
  }
}

export function retargetWorkspacePanel(state: WorkspacePanelState, input: WorkspacePanelTarget): WorkspacePanelState {
  return {
    ...state,
    workspaceDir: input.workspaceDir,
    targetPaneId: input.targetPaneId,
    navigator: nextNavigator(state, input),
    focus: nextFocus(state, input),
  }
}

export function closeWorkspacePanel(state: WorkspacePanelState): WorkspacePanelState {
  if (!state.open) return state
  return {
    ...state,
    open: false,
  }
}
