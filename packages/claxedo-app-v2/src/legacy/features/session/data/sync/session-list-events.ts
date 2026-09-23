import { Binary } from "@opencode-ai/ui/utils/binary"
import type { AgentPermission as PermissionRequest } from "@claxedo/agent-runtime-contract"
import type { ClaxedoSession as Session } from "../session-types"
import { trimSessions } from "../../../../platform/sync/global-sync/session-trim"
import type { SessionLifecycleEvent } from "../session-lifecycle"
import { queryClient } from "@/platform/query/query-client"
import { isConversationEventType } from "../../conversation/conversation-event"
import { shellDataKeys } from "@/platform/sync/keys"
import { cleanupDroppedSessionCaches, cleanupSessionCaches } from "./session-cache-cleanup"
import type { DirectorySessionCacheValue } from "./queries"
import { isConcreteSessionTitle } from "../../lib/session-title-sync"
import { sessionEventCommands, sessionEventRow, sessionEventSummary, sessionRow } from "./session-event-info"

export type ClaxedoSessionLifecycleEvent = SessionLifecycleEvent

export function mergeCanonicalSessionUpdate(
  current: Session,
  canonical: Session,
  baseline?: Pick<Session, "title" | "time">,
) {
  if (canonical.id !== current.id) return current
  if (canonical.time.updated < current.time.updated) return current
  if (
    canonical.time.updated === current.time.updated &&
    canonical.title !== current.title &&
    isConcreteSessionTitle(current.title) &&
    (!baseline || baseline.time.updated !== current.time.updated || baseline.title !== current.title)
  ) return current
  return { ...current, ...canonical }
}

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
    case "session.commands": {
      const update = sessionEventCommands(input.event.properties)
      if (!update) return undefined
      const idx = Binary.search(input.cache.session, update.sessionID, (item) => item.id)
      if (!idx.found) return undefined
      const session = input.cache.session.slice()
      session[idx.index] = { ...session[idx.index], commands: update.commands }
      return { ...input.cache, session }
    }
    case "session.created": {
      const info = sessionEventRow(input.event.properties)
      if (!info) return undefined
      const idx = Binary.search(input.cache.session, info.id, (item) => item.id)
      if (idx.found) {
        const session = input.cache.session.slice()
        session[idx.index] = mergeCanonicalSessionUpdate(session[idx.index], info)
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
      const info = sessionEventRow(input.event.properties)
      if (!info) return undefined
      const idx = Binary.search(input.cache.session, info.id, (item) => item.id)
      if (info.time.archived) {
        if (idx.found && info.time.updated < input.cache.session[idx.index].time.updated) return input.cache
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
        // Session updates are partial: preserve fields omitted by the producer.
        session[idx.index] = mergeCanonicalSessionUpdate(session[idx.index], info)
        return { ...input.cache, session }
      }
      const list = insertTrimmedSessionList(input.cache, info, idx.index, input.directory)
      return { ...input.cache, session: list }
    }
    case "session.deleted": {
      const info = sessionEventSummary(input.event.properties)
      if (!info) return undefined
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
  if (isConversationEventType(input.event.type)) return undefined
  const next = applySessionListEvent(input)
  if (next) return next
  switch (input.event.type) {
    case "process.status":
    case "process.started":
    case "process.stopped":
    case "process.crashed":
    case "process.config.changed":
      // Handled by ProcessPaneProvider via direct SSE subscription.
      return undefined
    case "vcs.branch.updated":
      // Runtime VCS is query-owned in Claxedo; do not revive upstream's
      // Solid store mirror for branch updates.
      return undefined
    case "session.status":
    case "session.idle":
    case "session.error":
    case "permission.asked":
    case "permission.replied":
    case "question.asked":
    case "question.replied":
    case "question.rejected":
      return undefined
    case "server.instance.disposed":
      input.push(input.directory)
      return undefined
    default:
    return undefined
  }
}

// `session.lifecycle` `creating` / `failed` events are owned by
// `session/submit/create-with-lifecycle.ts` — the submit wrapper subscribes
// directly and either reconciles them with the HTTP response or marks the
// draft as rolled back. This projection therefore only handles the `created`
// phase, which is the one that needs to project the new session into the
// per-directory session list. `creating` and `failed` events never carry a
// `sessionID`, so there is no live session row to attach UI state to in
// those phases anyway.
export function applyClaxedoSessionLifecycleEvent(input: {
  event: ClaxedoSessionLifecycleEvent
  push: (directory: string) => void
  cache: DirectorySessionCacheValue
  directory: string
}) {
  if (input.event.directory !== input.directory) return undefined
  if (input.event.phase !== "created" || !input.event.info) return undefined
  // Canonical event type carries `info?: unknown` so cross-package consumers
  // (server bus + frontend events provider) share one envelope. Narrow to the
  // upstream `Session` shape at the projection site, the one place it reads `.id`.
  const info = sessionRow(input.event.info)
  if (!info) return undefined
  return applySessionListEvent({
    ...input,
    event: { type: "session.created", properties: { info } },
  })
}
