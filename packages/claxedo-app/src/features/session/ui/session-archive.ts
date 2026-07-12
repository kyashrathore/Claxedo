// Pure decision logic for archiving/deleting a session and choosing where to
// navigate next.
//
// `session.tsx` (archiveSession), `message-timeline.tsx` (archiveSession) and
// `message-timeline.tsx` (deleteSession) each re-implemented the same two
// steps inline, and had already drifted: the delete path pre-filters the list
// to top-level unarchived sessions before picking a sibling, while the archive
// paths did not. Both steps are pure and now live here so a fix reaches every
// call site.

/**
 * Given the ordered session list and the id being removed, pick the sibling to
 * navigate to next: the following session if present, otherwise the preceding
 * one, otherwise `undefined`. Returns `undefined` when the target is not in the
 * list (its next-sibling is then meaningless).
 */
export function nextSiblingAfterRemoval<T extends { id: string }>(
  sessions: readonly T[],
  targetSessionID: string,
): T | undefined {
  const index = sessions.findIndex((session) => session.id === targetSessionID)
  if (index === -1) return undefined
  return sessions[index + 1] ?? sessions[index - 1]
}

export type SessionRemovalNavigation =
  | { readonly kind: "none" }
  | { readonly kind: "parent"; readonly sessionID: string }
  | { readonly kind: "next"; readonly sessionID: string }
  | { readonly kind: "root" }

/**
 * Decide where to navigate after the target session is removed.
 *
 * - When the removed session is not the one currently open, stay put (`none`).
 * - Otherwise prefer the parent session, then the pre-computed next sibling,
 *   then fall back to the workspace's session root.
 */
export function sessionRemovalNavigation(input: {
  currentSessionID: string | undefined
  targetSessionID: string
  parentID?: string
  nextSessionID?: string
}): SessionRemovalNavigation {
  if (input.currentSessionID !== input.targetSessionID) return { kind: "none" }
  if (input.parentID) return { kind: "parent", sessionID: input.parentID }
  if (input.nextSessionID) return { kind: "next", sessionID: input.nextSessionID }
  return { kind: "root" }
}
