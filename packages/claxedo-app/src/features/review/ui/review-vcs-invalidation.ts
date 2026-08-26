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
 * What one watcher path makes stale, or `undefined` when the path is
 * droppable churn.
 *
 * `.git/` is mostly bookkeeping noise (object-store writes, `*.lock` files
 * around every command), but two path families are the AUTHORITATIVE record of
 * state the review reads and must NOT be dropped:
 *
 * - `.git/index` is exactly what `git add` / `git reset` write. An index-only
 *   change moves files between the staged and unstaged sets with no worktree
 *   event at all, and the review caches are infinite-stale, so dropping it
 *   would leave them wrong forever.
 * - `HEAD`, `refs/`, and `packed-refs` are what branch switches and commits
 *   write, and this module already models branch freshness.
 *
 * `*.lock` churn (`.git/index.lock` bracketing every index write) stays
 * dropped so a single `git add` does not double-fire; the caller's debounce
 * absorbs the remaining lock-then-index pairing.
 */
function watcherFileInvalidation(file: unknown): ReviewVcsInvalidation | undefined {
  if (typeof file !== "string" || file.length === 0) return undefined
  if (!file.startsWith(".git/")) return { diffs: true, branch: false }
  if (file.endsWith(".lock")) return undefined
  if (file === ".git/index") return { diffs: true, branch: false }
  if (file === ".git/HEAD" || file === ".git/packed-refs" || file.startsWith(".git/refs/")) {
    return { diffs: true, branch: true }
  }
  return undefined
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
  return watcherFileInvalidation(record(event.properties)?.file) ?? NOTHING
}

/**
 * Directory-level staleness: what does this runtime event make out of date for
 * the workspace, whichever session caused it?
 *
 * Unlike `reviewVcsInvalidationFromEvent` this tracks every session on the
 * stream, because the stream is already directory-scoped and ANY session's
 * settled turn may have edited the worktree the review describes.
 *
 * It returns the same `{ diffs, branch }` pair rather than one boolean because
 * its caller owns two caches with different lifetimes: the review/file-status
 * reads follow `diffs`, and the runtime VCS summary (branch and default
 * branch, `queryKeys.runtime.vcs`) follows `branch`. Collapsing them would
 * either refetch the branch on every file save or never refetch it at all.
 */
export function createReviewVcsDirectoryClassifier() {
  const statusBySession = new Map<string, string>()
  return (event: ReviewVcsEvent): ReviewVcsInvalidation => {
    if (event.type === "session.status") {
      const properties = record(event.properties) as
        | { sessionID?: string; status?: { type?: string } }
        | undefined
      const sessionID = properties?.sessionID
      if (!sessionID) return NOTHING
      const next = properties.status?.type ?? "idle"
      const previous = statusBySession.get(sessionID)
      statusBySession.delete(sessionID)
      statusBySession.set(sessionID, next)
      while (statusBySession.size > 128) {
        const oldest = statusBySession.keys().next().value
        if (oldest === undefined) break
        statusBySession.delete(oldest)
      }
      // A settled turn edits the worktree; it never moves HEAD on its own —
      // if it did commit or switch branches, the watcher reports `.git/HEAD`.
      return { diffs: next === "idle" && previous !== undefined && previous !== "idle", branch: false }
    }
    if (event.type === "vcs.branch.updated") return { diffs: true, branch: true }
    if (event.type !== "file.watcher.updated") return NOTHING
    return watcherFileInvalidation(record(event.properties)?.file) ?? NOTHING
  }
}
