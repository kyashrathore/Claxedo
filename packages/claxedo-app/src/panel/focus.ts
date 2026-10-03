import { unreachable } from "@/lib/machine"
import {
  REVIEW_TAB_ID,
  openBrowserWorkspaceTab,
  openContextWorkspaceTab,
  openFileWorkspaceTab,
  openPlanWorkspaceTab,
  openSubagentWorkspaceTab,
} from "./workspace-tabs"
import type { ReviewFocus } from "@/review"
import type { WorkingSet } from "./working-sets"

export type PanelFocus =
  | { readonly kind: "review"; readonly path?: string }
  | { readonly kind: "file"; readonly path: string; readonly line?: number; readonly col?: number }
  | { readonly kind: "browser"; readonly url?: string }
  | { readonly kind: "context"; readonly sessionId: string }
  | {
      readonly kind: "subagent"
      readonly sessionId: string
      readonly parentSessionId: string
      readonly label?: string
      readonly description?: string
    }
  | {
      readonly kind: "plan"
      readonly sessionId: string
      readonly planId: string
      readonly title?: string
      readonly markdown: string
    }

export type FileReveal = {
  readonly path: string
  readonly line?: number
  readonly col?: number
  readonly version: number
}

export type FocusEffects = {
  readonly reveal: (reveal: FileReveal) => void
  readonly review: (focus: ReviewFocus) => void
  readonly nextVersion: () => number
}

const FILE_TAB_PREFIX = "file://"

export function fileTabId(path: string): string {
  return `${FILE_TAB_PREFIX}${path}`
}

export function filePathFromTab(tabId: string): string | undefined {
  return tabId.startsWith(FILE_TAB_PREFIX) ? tabId.slice(FILE_TAB_PREFIX.length) : undefined
}

function withTabs(
  set: WorkingSet,
  next: { readonly tabs: WorkingSet["tabs"]; readonly activeTabId: string },
): WorkingSet {
  return { ...set, tabs: next.tabs, activeTabId: next.activeTabId }
}

function focusFile(set: WorkingSet, focus: Extract<PanelFocus, { kind: "file" }>, effects: FocusEffects): WorkingSet {
  effects.reveal({ path: focus.path, line: focus.line, col: focus.col, version: effects.nextVersion() })
  return withTabs(set, openFileWorkspaceTab({ tabs: set.tabs, tabId: fileTabId(focus.path) }))
}

function focusReview(
  set: WorkingSet,
  focus: Extract<PanelFocus, { kind: "review" }>,
  effects: FocusEffects,
): WorkingSet {
  if (focus.path !== undefined) effects.review({ path: focus.path, version: effects.nextVersion() })
  return { ...set, activeTabId: REVIEW_TAB_ID }
}

export function applyFocus(set: WorkingSet, focus: PanelFocus, effects: FocusEffects): WorkingSet {
  switch (focus.kind) {
    case "review":
      return focusReview(set, focus, effects)
    case "file":
      return focusFile(set, focus, effects)
    case "browser":
      return withTabs(
        set,
        openBrowserWorkspaceTab({
          tabs: set.tabs,
          browserId: "browser",
          url: focus.url,
          navigationVersion: effects.nextVersion(),
        }),
      )
    case "context":
      return withTabs(set, openContextWorkspaceTab({ tabs: set.tabs, sessionId: focus.sessionId }))
    case "subagent":
      return withTabs(set, openSubagentWorkspaceTab({ tabs: set.tabs, ...focus }))
    case "plan":
      return withTabs(set, openPlanWorkspaceTab({ tabs: set.tabs, ...focus }))
    default:
      return unreachable(focus)
  }
}
