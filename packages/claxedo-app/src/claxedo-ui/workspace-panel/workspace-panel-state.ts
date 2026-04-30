export type WorkspacePanelMode = "files" | "changes" | "review" | "tasks" | "browser" | "processes"
export type WorkspacePanelNavigator = "files" | "processes"

/**
 * Tabs inside the workspace panel.
 *
 * The panel always has a `review` tab (non-closable). Users can open browser
 * tabs via the `+` menu. Each browser tab carries its own URL/title and is
 * mounted as an independent BrowserPane instance.
 *
 * Files / Processes / etc. are NOT tabs — they're navigators that overlay
 * the active tab's content (orthogonal axis).
 */
export type WorkspacePanelTab =
  | { id: "review"; type: "review" }
  | { id: string; type: "browser"; url?: string; title?: string }
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
  tabs: WorkspacePanelTab[]
  activeTabId: string
}

export type WorkspacePanelTarget = {
  workspaceDir?: string
  targetPaneId?: string
  navigator?: WorkspacePanelNavigator | null
  focus?: WorkspacePanelFocusTarget | null
}

const REVIEW_TAB: WorkspacePanelTab = { id: "review", type: "review" }

export function createWorkspacePanel(): WorkspacePanelState {
  return {
    open: false,
    tabs: [REVIEW_TAB],
    activeTabId: "review",
  }
}

let browserTabCounter = 0

export function addBrowserPanelTab(
  state: WorkspacePanelState,
  input: { url?: string; title?: string } = {},
): WorkspacePanelState {
  // Stable-enough id without crypto: persisted state survives reload
  // intentionally using a sequence so tests are deterministic.
  const id = `browser-${Date.now().toString(36)}-${(browserTabCounter++).toString(36)}`
  const tab: WorkspacePanelTab = { id, type: "browser", url: input.url, title: input.title }
  return {
    ...state,
    tabs: [...state.tabs, tab],
    activeTabId: id,
  }
}

export function closePanelTab(state: WorkspacePanelState, tabId: string): WorkspacePanelState {
  // The review tab is structural — refuse to close it.
  if (tabId === "review") return state
  const idx = state.tabs.findIndex((t) => t.id === tabId)
  if (idx < 0) return state
  const remaining = state.tabs.filter((t) => t.id !== tabId)
  // If the closed tab was active, fall back to the previous tab (or review).
  let nextActive = state.activeTabId
  if (state.activeTabId === tabId) {
    const prev = remaining[Math.max(0, idx - 1)]
    nextActive = prev?.id ?? "review"
  }
  return { ...state, tabs: remaining, activeTabId: nextActive }
}

export function setActivePanelTab(state: WorkspacePanelState, tabId: string): WorkspacePanelState {
  if (!state.tabs.some((t) => t.id === tabId)) return state
  return { ...state, activeTabId: tabId }
}

export function updateBrowserTabMeta(
  state: WorkspacePanelState,
  tabId: string,
  patch: { url?: string; title?: string },
): WorkspacePanelState {
  const idx = state.tabs.findIndex((t) => t.id === tabId && t.type === "browser")
  if (idx < 0) return state
  const next = state.tabs.slice()
  next[idx] = { ...(next[idx] as Extract<WorkspacePanelTab, { type: "browser" }>), ...patch }
  return { ...state, tabs: next }
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
