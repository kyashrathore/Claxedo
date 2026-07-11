import { Binary } from "@/utils/binary"
import type { PermissionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { trimSessions } from "../../context/global-sync/session-trim"
import type { SessionLifecycleEvent } from "../../shared/data/session-lifecycle"
import { queryClient } from "../../shared/query/query-client"
import { isConversationEventType } from "../chat/conversation-event"
import { shellDataKeys } from "./keys"
import { cleanupDroppedSessionCaches, cleanupSessionCaches } from "./session-cache-cleanup"
import type { DirectorySessionCacheValue } from "./queries"

// Canonical envelope lives in `shared/data/session-lifecycle` (rubric D4). This module
// re-exports under the historical alias so existing imports keep working while
// lifecycle projection moves out of the generic event reducer.
export type ClaxedoSessionLifecycleEvent = SessionLifecycleEvent

function permissionMapForTrim(sessions: Session[]) {
  const permission: Record<string, PermissionRequest[]> = {}
  for (const session of sessions) {
    const cached = queryClient.getQueryData<{ permissions: PermissionRequest[] }>(
      shellDataKeys.sessionId(session.id, "requests"),
    )
    if (cached?.permissions.length) permission[session.id] = cached.permissions
  }
  return permission
}

// Insert `info` at `insertIndex`, re-trim to the cache limit (protecting
// open/permission-held sessions), and evict caches for any rows that fell out.
// Shared by the `session.created` branch and the not-yet-present
// `session.updated` branch so the splice+trim+cleanup sequence lives once.
function insertTrimmedSessionList(
  cache: DirectorySessionCacheValue,
  info: Session,
  insertIndex: number,
  directory: string,
): Session[] {
  const previous = cache.session.slice()
  const next = previous.slice()
  next.splice(insertIndex, 0, info)
  const list = trimSessions(next, { limit: cache.limit, permission: permissionMapForTrim(next) })
  cleanupDroppedSessionCaches(previous, list, directory)
  return list
}

export function applySessionListEvent(input: {
  event: { type: string; properties?: unknown }
  cache: DirectorySessionCacheValue
  directory: string
}): DirectorySessionCacheValue | undefined {
  switch (input.event.type) {
    case "session.created": {
      const info = (input.event.properties as { info: Session }).info
      const idx = Binary.search(input.cache.session, info.id, (item) => item.id)
      if (idx.found) {
        const session = input.cache.session.slice()
        session[idx.index] = info
        return { ...input.cache, session }
      }
      const list = insertTrimmedSessionList(input.cache, info, idx.index, input.directory)
      return {
        ...input.cache,
        total: input.cache.total + (info.parentID ? 0 : 1),
        session: list,
      }
    }
    case "session.updated": {
      const info = (input.event.properties as { info: Session }).info
      const idx = Binary.search(input.cache.session, info.id, (item) => item.id)
      if (info.time.archived) {
        const session = input.cache.session.slice()
        if (idx.found) {
          session.splice(idx.index, 1)
        }
        cleanupSessionCaches(info.id)
        return {
          ...input.cache,
          total: info.parentID ? input.cache.total : Math.max(0, input.cache.total - 1),
          session,
        }
      }
      if (idx.found) {
        const session = input.cache.session.slice()
        session[idx.index] = info
        return { ...input.cache, session }
      }
      const list = insertTrimmedSessionList(input.cache, info, idx.index, input.directory)
      return { ...input.cache, session: list }
    }
    case "session.deleted": {
      const info = (input.event.properties as { info: Session }).info
      const idx = Binary.search(input.cache.session, info.id, (item) => item.id)
      const session = input.cache.session.slice()
      if (idx.found) {
        session.splice(idx.index, 1)
      }
      cleanupSessionCaches(info.id)
      return {
        ...input.cache,
        total: info.parentID ? input.cache.total : Math.max(0, input.cache.total - 1),
        session,
      }
    }
    default:
      return undefined
  }
}

export function applyDirectorySessionCacheEvent(input: {
  event: { type: string; properties?: unknown }
  cache: DirectorySessionCacheValue
  push: (directory: string) => void
  directory: string
}): DirectorySessionCacheValue | undefined {
  if (isConversationEventType(input.event.type)) return
  const next = applySessionListEvent(input)
  if (next) return next
  switch (input.event.type) {
    case "process.status":
    case "process.started":
    case "process.stopped":
    case "process.crashed":
    case "process.config.changed":
      // Handled by ProcessPaneProvider via direct SSE subscription.
      return
    case "vcs.branch.updated":
      // Runtime VCS is query-owned in Claxedo; do not revive upstream's
      // Solid store mirror for branch updates.
      return
    case "session.status":
    case "session.idle":
    case "session.error":
    case "permission.asked":
    case "permission.replied":
    case "question.asked":
    case "question.replied":
    case "question.rejected":
      return
    case "server.instance.disposed":
      input.push(input.directory)
      return
    default:
      return
  }
}

// `session.lifecycle` `creating` / `failed` events are owned by
// `session/submit/create-with-lifecycle.ts` — the submit wrapper subscribes
// directly and either reconciles them with the HTTP response or marks the
// draft as rolled back. This projection therefore only handles the `created`
// phase, which is the one that needs to project the new session into the
// per-directory session list. Server protocol confirmation
// (rubric C5 / bug-bash open question #5): `creating` and `failed` events
// never carry a `sessionID` — there is no live session row to attach UI
// state to in those phases — so the dead branches that used to fire here
// were no-op-by-construction.
export function applyClaxedoSessionLifecycleEvent(input: {
  event: ClaxedoSessionLifecycleEvent
  push: (directory: string) => void
  cache: DirectorySessionCacheValue
  directory: string
}) {
  if (input.event.directory !== input.directory) return
  if (input.event.phase !== "created" || !input.event.info) return
  // Canonical event type carries `info?: unknown` so cross-package consumers
  // (server bus + frontend events provider) share one envelope. Narrow to the
  // upstream `Session` shape at the projection site, the one place it reads `.id`.
  return applySessionListEvent({
    ...input,
    event: { type: "session.created", properties: { info: input.event.info as Session } },
  })
}
