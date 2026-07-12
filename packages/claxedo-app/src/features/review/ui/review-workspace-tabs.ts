const PROCESS_SECTION_PREFIX = "process:"

export type ReviewWorkspaceTab =
  | { id: "review"; kind: "review" }
  | { id: "context"; kind: "context"; sessionId: string }
  | { id: string; kind: "file"; tabId: string }
  | { id: "browser"; kind: "browser"; browserId: string }
  | { id: string; kind: "process"; processId: string }

export const REVIEW_TAB_ID = "review"
export const CONTEXT_TAB_ID = "context"
export const BROWSER_TAB_ID = "browser"
export const REVIEW_TAB: ReviewWorkspaceTab = { id: REVIEW_TAB_ID, kind: "review" }

export function processTabId(processId: string) {
  return `${PROCESS_SECTION_PREFIX}${processId}`
}

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

export function openProcessWorkspaceTab(input: { tabs: readonly ReviewWorkspaceTab[]; processId: string }) {
  const id = processTabId(input.processId)
  if (input.tabs.some((tab) => tab.id === id)) return { tabs: input.tabs, activeTabId: id, added: false }
  return {
    tabs: [...input.tabs, { id, kind: "process", processId: input.processId } satisfies ReviewWorkspaceTab],
    activeTabId: id,
    added: true,
  }
}

export function openContextWorkspaceTab(input: { tabs: readonly ReviewWorkspaceTab[]; sessionId: string }) {
  const index = input.tabs.findIndex((tab) => tab.kind === "context")
  if (index === -1) {
    return {
      tabs: [...input.tabs, { id: CONTEXT_TAB_ID, kind: "context", sessionId: input.sessionId } satisfies ReviewWorkspaceTab],
      activeTabId: CONTEXT_TAB_ID,
      added: true,
      contextIndex: undefined,
    }
  }
  return {
    tabs: input.tabs.map((tab, tabIndex) =>
      tabIndex === index ? { ...tab, sessionId: input.sessionId } as ReviewWorkspaceTab : tab
    ),
    activeTabId: CONTEXT_TAB_ID,
    added: false,
    contextIndex: index,
  }
}

export function openBrowserWorkspaceTab(input: { tabs: readonly ReviewWorkspaceTab[]; browserId: string }) {
  if (input.tabs.some((tab) => tab.kind === "browser")) {
    return { tabs: input.tabs, activeTabId: BROWSER_TAB_ID, added: false }
  }
  return {
    tabs: [...input.tabs, { id: BROWSER_TAB_ID, kind: "browser", browserId: input.browserId } satisfies ReviewWorkspaceTab],
    activeTabId: BROWSER_TAB_ID,
    added: true,
  }
}

export function nextActiveWorkspaceTabAfterClose(input: {
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
