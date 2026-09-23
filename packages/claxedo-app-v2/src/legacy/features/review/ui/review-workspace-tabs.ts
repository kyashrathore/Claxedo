const PROCESS_SECTION_PREFIX = "process:"
const SUBAGENT_SECTION_PREFIX = "subagent:"
const PLAN_SECTION_PREFIX = "plan:"

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
   *
   * `parentSessionId` is what makes the tab belong to a conversation rather than to
   * the workspace: the working set is keyed per workspace, so without it a switch to
   * another session keeps showing transcripts spawned by the one the reader left.
   */
  | {
    id: string
    kind: "subagent"
    sessionId: string
    parentSessionId: string
    label?: string
    description?: string
  }
  /** A plan the agent proposed in `sessionId`; it belongs to that conversation as a subagent tab does. */
  | { id: string; kind: "plan"; sessionId: string; planId: string; title?: string; markdown: string }

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

type SubagentWorkspaceTab = Extract<ReviewWorkspaceTab, { kind: "subagent" }>

function sameSubagentTab(left: SubagentWorkspaceTab, right: SubagentWorkspaceTab) {
  return left.parentSessionId === right.parentSessionId &&
    left.label === right.label &&
    left.description === right.description
}

export function openSubagentWorkspaceTab(input: {
  tabs: readonly ReviewWorkspaceTab[]
  sessionId: string
  parentSessionId: string
  /** The spawning row already knows the agent's name; nothing else here does. */
  label?: string
  description?: string
}) {
  const id = subagentTabId(input.sessionId)
  const index = input.tabs.findIndex((tab) => tab.id === id)
  const found = index === -1 ? undefined : input.tabs[index]
  const existing = found?.kind === "subagent" ? found : undefined
  // The runtime rewrites the row's summary as the agent works, so a reopen
  // carries newer text than the tab holds; a reopen carrying none at all (a
  // restored focus, a keyboard repeat) must not blank what is already there.
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

export function planTabId(planId: string) {
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
  return { tabs: input.tabs.map((item, itemIndex) => (itemIndex === index ? tab : item)), activeTabId: id, added: false }
}

/**
 * The tabs the pane may show for `sessionId`. Subagent and plan tabs belong to the
 * conversation that produced them, so they are retained but hidden while another
 * session holds the pane; every other kind belongs to the workspace and always shows.
 */
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

/** Drop the deleted session's own transcript tab, every transcript it spawned, and its plans. */
export function closeSessionWorkspaceTabs(input: {
  tabs: readonly ReviewWorkspaceTab[]
  activeTabId: string
  sessionId: string
}) {
  const doomed = input.tabs.filter((tab) => {
    if (tab.kind === "subagent") return tab.sessionId === input.sessionId || tab.parentSessionId === input.sessionId
    return tab.kind === "plan" && tab.sessionId === input.sessionId
  })
  if (doomed.length === 0) return { tabs: input.tabs, activeTabId: input.activeTabId, removed: false }
  let tabs = input.tabs
  let activeTabId = input.activeTabId
  for (const tab of doomed) {
    const next = closeWorkspaceTab({ tabs, activeTabId, closeTabId: tab.id })
    tabs = next.tabs
    activeTabId = next.activeTabId
  }
  return { tabs, activeTabId, removed: true }
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
