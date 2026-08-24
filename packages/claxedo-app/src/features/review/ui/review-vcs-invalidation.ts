export type ReviewVcsEvent = {
  type: string
  properties?: unknown
}

export type ReviewVcsInvalidation = {
  /** The changed-file set is out of date. */
  diffs: boolean
  /** The branch and default-branch names are out of date. */
  branch: boolean
}

const NOTHING: ReviewVcsInvalidation = { diffs: false, branch: false }

function record(properties: unknown) {
  return typeof properties === "object" && properties ? (properties as Record<string, unknown>) : undefined
}

/**
 * What one runtime event makes stale for a review of `sessionId`.
 *
 * Pure, and separate from the subscription, because who owns the subscription
 * has changed: it used to live in ReviewTab, which now unmounts whenever
 * another workspace tab is active, and a review that stops watching goes
 * quietly stale instead of loudly wrong.
 */
export function reviewVcsInvalidationFromEvent(input: {
  event: ReviewVcsEvent
  sessionId?: string
  /** The last `session.status` type seen for this session, if any. */
  lastSessionStatusType?: string
}): ReviewVcsInvalidation & { nextSessionStatusType?: string } {
  const { event } = input
  if (event.type === "session.status") {
    const properties = record(event.properties) as { sessionID?: string; status?: { type?: string } } | undefined
    if (!properties || properties.sessionID !== input.sessionId) return NOTHING
    const next = properties.status?.type ?? "idle"
    // A turn that just finished is the moment its edits are complete.
    const settled = next === "idle" && !!input.lastSessionStatusType && input.lastSessionStatusType !== "idle"
    return { diffs: settled, branch: false, nextSessionStatusType: next }
  }
  if (event.type === "vcs.branch.updated") return { diffs: true, branch: true }
  if (event.type !== "file.watcher.updated") return NOTHING
  const file = record(event.properties)?.file
  // Git's own bookkeeping churns constantly and never changes the working tree.
  if (typeof file !== "string" || file.startsWith(".git/")) return NOTHING
  return { diffs: true, branch: false }
}

/**
 * Directory-level staleness: does this runtime event mean the workspace's
 * review data is out of date, whichever session caused it?
 *
 * Unlike `reviewVcsInvalidationFromEvent` this tracks every session on the
 * stream, because the stream is already directory-scoped and ANY session's
 * settled turn may have edited the worktree the review describes.
 */
export function createReviewVcsDirectoryClassifier() {
  const statusBySession = new Map<string, string>()
  return (event: ReviewVcsEvent): boolean => {
    if (event.type === "session.status") {
      const properties = record(event.properties) as
        | { sessionID?: string; status?: { type?: string } }
        | undefined
      const sessionID = properties?.sessionID
      if (!sessionID) return false
      const next = properties.status?.type ?? "idle"
      const previous = statusBySession.get(sessionID)
      statusBySession.delete(sessionID)
      statusBySession.set(sessionID, next)
      while (statusBySession.size > 128) {
        const oldest = statusBySession.keys().next().value
        if (oldest === undefined) break
        statusBySession.delete(oldest)
      }
      return next === "idle" && previous !== undefined && previous !== "idle"
    }
    if (event.type === "vcs.branch.updated") return true
    if (event.type !== "file.watcher.updated") return false
    const file = record(event.properties)?.file
    return typeof file === "string" && !file.startsWith(".git/")
  }
}
