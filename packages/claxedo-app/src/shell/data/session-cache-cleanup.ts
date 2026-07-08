import type { Session, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { hasOpenSession } from "../session/open-sessions"
import { queryClient } from "../../shared/query/query-client"
import { queryKeys } from "../../shared/query/keys"
import { shellDataKeys } from "./keys"
import { clearPromptSessionStatus, promptSessionStatusMeta } from "../../session/store/session-status-dispatcher"

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
