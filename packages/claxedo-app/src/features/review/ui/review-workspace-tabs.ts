const PROCESS_SECTION_PREFIX = "process:"
const SUBAGENT_SECTION_PREFIX = "subagent:"

export type ReviewWorkspaceTab =
  | { id: "review"; kind: "review" }
  | { id: "context"; kind: "context"; sessionId: string }
  | { id: string; kind: "file"; tabId: string }
  | { id: "browser"; kind: "browser"; browserId: string; url?: string; navigationVersion?: number }
  | { id: string; kind: "process"; processId: string }
  /**
   * A subagent's own session, opened beside the work that spawned it. Keyed by the
   * child session id rather than a fixed id, so a turn that spawns several holds
   * several tabs — the same shape `process` and `file` already use, and the reason
   * `context` (a singleton) could not carry these.
   */
  | { id: string; kind: "subagent"; sessionId: string; label?: string; description?: string }

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

export function subagentTabId(sessionId: string) {
  return `${SUBAGENT_SECTION_PREFIX}${sessionId}`
}

export function openSubagentWorkspaceTab(input: {
  tabs: readonly ReviewWorkspaceTab[]
  sessionId: string
  /** The spawning row already knows the agent's name; nothing else here does. */
  label?: string
  description?: string
}) {
  const id = subagentTabId(input.sessionId)
  if (input.tabs.some((tab) => tab.id === id)) return { tabs: input.tabs, activeTabId: id, added: false }
  return {
    tabs: [
      ...input.tabs,
      {
        id,
        kind: "subagent",
        sessionId: input.sessionId,
        ...(input.label ? { label: input.label } : {}),
        ...(input.description ? { description: input.description } : {}),
      } satisfies ReviewWorkspaceTab,
    ],
    activeTabId: id,
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
  // One tab value for both branches: a context tab holds nothing but these
  // three fields, so re-pointing an existing one at a session and adding a new
  // one produce the same tab — spreading the old one only widened its type.
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
        ? input.tabs.map((tab, tabIndex) => tabIndex === index
          ? { ...tab, url: input.url, navigationVersion: input.navigationVersion }
          : tab)
        : input.tabs,
      activeTabId: BROWSER_TAB_ID,
      added: false,
    }
  }
  return {
    tabs: [...input.tabs, {
      id: BROWSER_TAB_ID,
      kind: "browser",
      browserId: input.browserId,
      ...(input.url ? { url: input.url } : {}),
      ...(input.navigationVersion !== undefined ? { navigationVersion: input.navigationVersion } : {}),
    } satisfies ReviewWorkspaceTab],
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
