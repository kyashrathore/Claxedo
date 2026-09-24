import { createMemo, createSignal, type Accessor } from "solid-js"
import { persistedSignal, preferenceKey } from "@/lib/persisted"
import type { PlacementId } from "@/server"
import type { ReviewFocus } from "@/review"
import { applyFocus, type FileReveal, type PanelFocus } from "./focus"
import {
  REVIEW_TAB,
  closeWorkspaceTab,
  reviewWorkspaceTabsForSession,
  type ReviewWorkspaceTab,
  type WorkspacePanelNavigator,
} from "./workspace-tabs"
import { emptyWorkingSet, emptyWorkingSets, withWorkingSet, type WorkingSet } from "./working-sets"

export type PanelTabs = {
  readonly tabs: Accessor<readonly ReviewWorkspaceTab[]>
  readonly activeTab: Accessor<ReviewWorkspaceTab>
  readonly navigator: Accessor<WorkspacePanelNavigator | null>
  readonly activate: (tabId: string) => void
  readonly closeTab: (tabId: string) => void
  readonly toggleNavigator: (navigator: WorkspacePanelNavigator) => void
  readonly focus: (focus: PanelFocus) => void
  readonly fileReveal: Accessor<FileReveal | undefined>
  readonly reviewFocus: Accessor<ReviewFocus | undefined>
}

function readNavigator(value: unknown): WorkspacePanelNavigator | null | undefined {
  if (value === null || value === "files" || value === "changes") return value
  return undefined
}

function createWorkingSetStore(placementId: Accessor<PlacementId | undefined>) {
  const [sets, setSets] = createSignal(emptyWorkingSets)
  const current = createMemo((): WorkingSet => {
    const id = placementId()
    return (id === undefined ? undefined : sets().entries[id]) ?? emptyWorkingSet
  })
  const update = (change: (previous: WorkingSet) => WorkingSet) => {
    const id = placementId()
    if (id === undefined) return
    setSets((previous) => withWorkingSet(previous, id, change(current())))
  }
  return { current, update }
}

export function createPanelTabs(
  placementId: Accessor<PlacementId | undefined>,
  sessionId: Accessor<string>,
): PanelTabs {
  const workingSet = createWorkingSetStore(placementId)
  const [navigator, setNavigator] = persistedSignal<WorkspacePanelNavigator | null>(
    preferenceKey("panel", "navigator"),
    "files",
    readNavigator,
  )
  const [fileReveal, setFileReveal] = createSignal<FileReveal>()
  const [reviewFocus, setReviewFocus] = createSignal<ReviewFocus>()
  let version = 0
  const effects = { reveal: setFileReveal, review: setReviewFocus, nextVersion: () => ++version }
  const tabs = createMemo(() =>
    reviewWorkspaceTabsForSession({ tabs: workingSet.current().tabs, sessionId: sessionId() }),
  )
  return {
    tabs,
    activeTab: createMemo(() => tabs().find((tab) => tab.id === workingSet.current().activeTabId) ?? REVIEW_TAB),
    navigator,
    activate: (tabId) => workingSet.update((set) => ({ ...set, activeTabId: tabId })),
    closeTab: (tabId) =>
      workingSet.update((set) => {
        const next = closeWorkspaceTab({ tabs: set.tabs, activeTabId: set.activeTabId, closeTabId: tabId })
        return { tabs: next.tabs, activeTabId: next.activeTabId }
      }),
    toggleNavigator: (next) => setNavigator((current) => (current === next ? null : next)),
    focus: (focus) => workingSet.update((set) => applyFocus(set, focus, effects)),
    fileReveal,
    reviewFocus,
  }
}
