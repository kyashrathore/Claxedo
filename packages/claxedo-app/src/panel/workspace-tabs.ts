const SUBAGENT_SECTION_PREFIX = "subagent:"
const PLAN_SECTION_PREFIX = "plan:"

export type ReviewWorkspaceTab =
  | { id: "review"; kind: "review" }
  | { id: "context"; kind: "context"; sessionId: string }
  | { id: string; kind: "file"; tabId: string }
  | { id: "browser"; kind: "browser"; browserId: string; url?: string; navigationVersion?: number }
  | {
      id: string
      kind: "subagent"
      sessionId: string
      parentSessionId: string
      label?: string
      description?: string
    }
  | { id: string; kind: "plan"; sessionId: string; planId: string; title?: string; markdown: string }

export type WorkspacePanelNavigator = "files" | "changes"

export const REVIEW_TAB_ID = "review"
const CONTEXT_TAB_ID = "context"
const BROWSER_TAB_ID = "browser"
export const REVIEW_TAB: ReviewWorkspaceTab = { id: REVIEW_TAB_ID, kind: "review" }

export function openFileWorkspaceTab(input: { tabs: readonly ReviewWorkspaceTab[]; tabId: string }) {
  if (input.tabs.some((tab) => tab.id === input.tabId)) {
    return { tabs: input.tabs, activeTabId: input.tabId, added: false }
  }
  return {
    tabs: [...input.tabs, { id: input.tabId, kind: "file", tabId: input.tabId } satisfies ReviewWorkspaceTab],
    activeTabId: input.tabId,
    added: true,
  }
}

function subagentTabId(sessionId: string) {
  return `${SUBAGENT_SECTION_PREFIX}${sessionId}`
}

type SubagentWorkspaceTab = Extract<ReviewWorkspaceTab, { kind: "subagent" }>

function sameSubagentTab(left: SubagentWorkspaceTab, right: SubagentWorkspaceTab) {
  return (
    left.parentSessionId === right.parentSessionId &&
    left.label === right.label &&
    left.description === right.description
  )
}

export function openSubagentWorkspaceTab(input: {
  tabs: readonly ReviewWorkspaceTab[]
  sessionId: string
  parentSessionId: string
  label?: string
  description?: string
}) {
  const id = subagentTabId(input.sessionId)
  const index = input.tabs.findIndex((tab) => tab.id === id)
  const found = index === -1 ? undefined : input.tabs[index]
  const existing = found?.kind === "subagent" ? found : undefined
  const label = input.label ?? existing?.label
  const description = input.description ?? existing?.description
  const tab = {
    id,
    kind: "subagent",
    sessionId: input.sessionId,
    parentSessionId: input.parentSessionId,
    ...(label ? { label } : {}),
    ...(description ? { description } : {}),
  } satisfies ReviewWorkspaceTab
  if (!existing) return { tabs: [...input.tabs, tab], activeTabId: id, added: true }
  if (sameSubagentTab(existing, tab)) return { tabs: input.tabs, activeTabId: id, added: false }
  return {
    tabs: input.tabs.map((item, itemIndex) => (itemIndex === index ? tab : item)),
    activeTabId: id,
    added: false,
  }
}

function planTabId(planId: string) {
  return `${PLAN_SECTION_PREFIX}${planId}`
}

export function openPlanWorkspaceTab(input: {
  tabs: readonly ReviewWorkspaceTab[]
  sessionId: string
  planId: string
  title?: string
  markdown: string
}) {
  const id = planTabId(input.planId)
  const tab = {
    id,
    kind: "plan",
    sessionId: input.sessionId,
    planId: input.planId,
    ...(input.title ? { title: input.title } : {}),
    markdown: input.markdown,
  } satisfies ReviewWorkspaceTab
  const index = input.tabs.findIndex((item) => item.id === id)
  if (index === -1) return { tabs: [...input.tabs, tab], activeTabId: id, added: true }
  const existing = input.tabs[index]
  if (existing?.kind === "plan" && existing.markdown === tab.markdown && existing.title === tab.title) {
    return { tabs: input.tabs, activeTabId: id, added: false }
  }
  return {
    tabs: input.tabs.map((item, itemIndex) => (itemIndex === index ? tab : item)),
    activeTabId: id,
    added: false,
  }
}

export function reviewWorkspaceTabsForSession(input: {
  tabs: readonly ReviewWorkspaceTab[]
  sessionId: string
}): ReviewWorkspaceTab[] {
  return input.tabs.filter((tab) => {
    if (tab.kind === "subagent") return tab.parentSessionId === input.sessionId
    if (tab.kind === "plan") return tab.sessionId === input.sessionId
    return true
  })
}

export function openContextWorkspaceTab(input: { tabs: readonly ReviewWorkspaceTab[]; sessionId: string }) {
  const contextTab = {
    id: CONTEXT_TAB_ID,
    kind: "context",
    sessionId: input.sessionId,
  } satisfies ReviewWorkspaceTab
  const index = input.tabs.findIndex((tab) => tab.kind === "context")
  if (index === -1) {
    return {
      tabs: [...input.tabs, contextTab],
      activeTabId: CONTEXT_TAB_ID,
      added: true,
      contextIndex: undefined,
    }
  }
  return {
    tabs: input.tabs.map((tab, tabIndex) => (tabIndex === index ? contextTab : tab)),
    activeTabId: CONTEXT_TAB_ID,
    added: false,
    contextIndex: index,
  }
}

export function openBrowserWorkspaceTab(input: {
  tabs: readonly ReviewWorkspaceTab[]
  browserId: string
  url?: string
  navigationVersion?: number
}) {
  const index = input.tabs.findIndex((tab) => tab.kind === "browser")
  if (index !== -1) {
    return {
      tabs: input.url
        ? input.tabs.map((tab, tabIndex) =>
            tabIndex === index ? { ...tab, url: input.url, navigationVersion: input.navigationVersion } : tab,
          )
        : input.tabs,
      activeTabId: BROWSER_TAB_ID,
      added: false,
    }
  }
  return {
    tabs: [
      ...input.tabs,
      {
        id: BROWSER_TAB_ID,
        kind: "browser",
        browserId: input.browserId,
        ...(input.url ? { url: input.url } : {}),
        ...(input.navigationVersion !== undefined ? { navigationVersion: input.navigationVersion } : {}),
      } satisfies ReviewWorkspaceTab,
    ],
    activeTabId: BROWSER_TAB_ID,
    added: true,
  }
}

function nextActiveWorkspaceTabAfterClose(input: {
  tabs: readonly ReviewWorkspaceTab[]
  activeTabId: string
  closeTabId: string
}) {
  if (input.activeTabId !== input.closeTabId) return input.activeTabId
  const index = input.tabs.findIndex((tab) => tab.id === input.closeTabId)
  const remaining = input.tabs.filter((tab) => tab.id !== input.closeTabId)
  if (remaining.length === 0) return REVIEW_TAB_ID
  return remaining[Math.min(index, remaining.length - 1)]?.id ?? REVIEW_TAB_ID
}

export function closeWorkspaceTab(input: {
  tabs: readonly ReviewWorkspaceTab[]
  activeTabId: string
  closeTabId: string
}) {
  if (input.closeTabId === REVIEW_TAB_ID || !input.tabs.some((tab) => tab.id === input.closeTabId)) {
    return { tabs: input.tabs, activeTabId: input.activeTabId, removed: false }
  }
  return {
    tabs: input.tabs.filter((tab) => tab.id !== input.closeTabId),
    activeTabId: nextActiveWorkspaceTabAfterClose(input),
    removed: true,
  }
}
