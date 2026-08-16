import type { Session, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { hasOpenSession } from "@/features/session/store/open-sessions"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { shellDataKeys } from "@/platform/sync/keys"
import { clearPromptSessionStatus, promptSessionStatusMeta } from "../../store/session-status-dispatcher"

export const SESSION_CACHE_LIMIT = 40
const SESSION_ACTIVITY_GRACE_MS = 30_000

function cachedDirectorySession(directory: string | undefined, sessionId: string) {
  if (!directory) return undefined
  return queryClient.getQueryData<{ session: Session[] }>(
    queryKeys.directory.sessionCache(directory),
  )?.session.find((item) => item.id === sessionId)
}

function recentlyActive(directory: string | undefined, sessionId: string) {
  const statusStarted = promptSessionStatusMeta(sessionId)?.started
  if (statusStarted && Date.now() - statusStarted < SESSION_ACTIVITY_GRACE_MS) return true
  const session = cachedDirectorySession(directory, sessionId)
  const sessionUpdated = session?.time?.updated ?? session?.time?.created
  if (!sessionUpdated) return false
  return Date.now() - sessionUpdated < SESSION_ACTIVITY_GRACE_MS
}

function shellSessionStatus(sessionId: string) {
  return queryClient.getQueryData<SessionStatus>(
    shellDataKeys.sessionId(sessionId, "status"),
  )
}

function removeSessionShellQueries(sessionID: string) {
  queryClient.removeQueries({ queryKey: shellDataKeys.sessionId(sessionID) })
}

export function droppedSessionIDs(previous: Session[], next: Session[]) {
  const keep = new Set(next.map((item) => item.id))
  return previous.map((item) => item.id).filter((sessionId) => !keep.has(sessionId))
}

export function cleanupDroppedSessionCaches(
  previous: Session[],
  next: Session[],
  directory?: string,
) {
  const stale = droppedSessionIDs(previous, next).filter((sessionId) => {
    if (!directory) return true
    if (hasOpenSession(sessionId)) return false
    const status = shellSessionStatus(sessionId)
    if (status && status.type !== "idle" && recentlyActive(directory, sessionId)) return false
    return true
  })
  for (const sessionId of stale) {
    removeSessionShellQueries(sessionId)
    clearPromptSessionStatus(sessionId)
  }
}

export function cleanupSessionCaches(sessionId: string) {
  if (!sessionId) return
  removeSessionShellQueries(sessionId)
  clearPromptSessionStatus(sessionId)
}

/**
 * Session ids that currently hold shell caches, coldest first.
 *
 * Derived from the query cache rather than tracked in a module-level set: the
 * cache already knows both WHICH sessions it holds and WHEN each was last
 * written (`dataUpdatedAt`), so reading it is strictly more truthful than
 * parallel bookkeeping that can drift out of sync with the thing it describes
 * — and it keeps this module free of mutable module state.
 */
function liveSessionsColdestFirst(): string[] {
  const newest = new Map<string, number>()
  for (const query of queryClient.getQueryCache().getAll()) {
    const key = query.queryKey
    if (!Array.isArray(key) || key[0] !== "shell" || key[1] !== "session") continue
    const sessionId = key[2]
    if (typeof sessionId !== "string" || !sessionId) continue
    const at = query.state.dataUpdatedAt ?? 0
    newest.set(sessionId, Math.max(newest.get(sessionId) ?? 0, at))
  }
  return [...newest.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id)
}

/**
 * Enforce the count-based ceiling on per-session shell caches
 * (status/requests/todo/diff), keeping `sessionId` and dropping the coldest
 * beyond `SESSION_CACHE_LIMIT`.
 *
 * This is the ONLY count-based bound on that growth. `cleanupDroppedSessionCaches`
 * fires when the SERVER drops a session from its list, and `gcTime` is a
 * 30-minute wall clock that every refetch resets — neither reacts to how many
 * sessions the client has accumulated. `SESSION_CACHE_LIMIT` and
 * `pickSessionCacheEvictions` shipped in 2531335 with ZERO callers anywhere in
 * the tree and no tests: a written-down memory policy that never ran. Wiring it
 * is what makes the ceiling real, and it matters most under mixed load — many
 * sessions across several harnesses and workspaces, where the two structures
 * that ARE capped (10 workbench tabs, 32 conversation clients) both spill their
 * data into this uncapped one by design.
 *
 * Two exemptions, both load-bearing:
 *  - OPEN sessions — a mounted tab must never lose the caches it renders from.
 *  - BUSY sessions — dropping status/requests mid-turn would strand a streaming
 *    session's UI, and a background turn is exactly the case a recency-ranked
 *    eviction would otherwise hit first.
 */
export function enforceSessionCacheCeiling(sessionId: string) {
  if (!sessionId || sessionId === "new") return []
  const seen = new Set(liveSessionsColdestFirst())
  const preserve: string[] = []
  for (const id of seen) {
    if (hasOpenSession(id)) preserve.push(id)
    else {
      const status = shellSessionStatus(id)
      if (status && status.type !== "idle") preserve.push(id)
    }
  }
  const evicted = pickSessionCacheEvictions({
    seen,
    keep: sessionId,
    limit: SESSION_CACHE_LIMIT,
    preserve,
  })
  for (const id of evicted) {
    removeSessionShellQueries(id)
    clearPromptSessionStatus(id)
  }
  return evicted
}

export function pickSessionCacheEvictions(input: {
  seen: Set<string>
  keep: string
  limit: number
  preserve?: Iterable<string>
}) {
  const stale: string[] = []
  const keep = new Set([input.keep, ...Array.from(input.preserve ?? [])])
  if (input.seen.has(input.keep)) input.seen.delete(input.keep)
  input.seen.add(input.keep)
  for (const id of input.seen) {
    if (input.seen.size - stale.length <= input.limit) break
    if (keep.has(id)) continue
    stale.push(id)
  }
  for (const id of stale) {
    input.seen.delete(id)
  }
  return stale
}
