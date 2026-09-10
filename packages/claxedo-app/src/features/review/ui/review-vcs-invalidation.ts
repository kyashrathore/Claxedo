import { asRecord, readField, readString } from "@/lib/record"

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

/** The two fields the classifier reads off a `session.status` payload. */
function sessionStatus(properties: unknown) {
  const body = asRecord(properties)
  if (!body) return undefined
  return {
    sessionID: readString(body, "sessionID"),
    type: readString(readField(body, "status"), "type") ?? "idle",
  }
}

/**
 * What one watcher path makes stale, or `undefined` when the path is
 * droppable churn.
 *
 * `.git/` is mostly bookkeeping noise (object-store writes, `*.lock` files
 * around every command), but two path families are the authoritative record of
 * state the review reads and must not be dropped:
 *
 * - `.git/index` is what `git add` / `git reset` write. An index-only
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
 * Directory-level staleness: what does this runtime event make out of date for
 * the workspace, whichever session caused it?
 *
 * It tracks every session on the stream, because the stream is already
 * directory-scoped and any session's settled turn may have edited the worktree
 * the review describes.
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
      const status = sessionStatus(event.properties)
      const sessionID = status?.sessionID
      if (!sessionID) return NOTHING
      const next = status.type
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
    return watcherFileInvalidation(readField(event.properties, "file")) ?? NOTHING
  }
}
