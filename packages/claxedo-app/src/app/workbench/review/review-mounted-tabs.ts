/**
 * Which inner Workspace tabs own DOM.
 *
 * Only the active one. Deactivated tabs used to stay mounted so a switch back
 * was instant, but a closed or inactive tab that still owns a live DOM tree,
 * its listeners, and its observers is exactly the hidden ownership a disposed
 * Workspace is supposed to give back. What a tab needs to come back is
 * restored instead: the panel's working set carries the tab list and the Review
 * surface, and TabFile re-reads from the canonical request cache.
 *
 * The one exception is a tab whose activation is prepared but not yet
 * committed. It mounts for that frame so its content is laid out before it
 * becomes active — the ordering `createReviewTabActivation` relies on to
 * capture the Review scroll before a tab insertion can clamp it.
 */
export function reviewWorkspaceMountedTabs<Tab extends { id: string; kind: string }>(input: {
  tabs: readonly Tab[]
  activeTabId: string
  reviewTabId: string
  pendingTabId?: string
}): Tab[] {
  const active = input.activeTabId === input.reviewTabId ? undefined : input.activeTabId
  return input.tabs.filter((tab) =>
    tab.kind !== "review" && (tab.id === active || tab.id === input.pendingTabId)
  )
}
