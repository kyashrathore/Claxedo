import { applyClaxedoSessionLifecycleEvent, type ClaxedoSessionLifecycleEvent } from "@/features/session/data/sync/session-list-events"
import { invalidateSessionListQueries, upsertCreatedSessionListRow } from "@/features/session/data/query/session-list"
import type { DirectorySessionCacheValue } from "../../../features/session/data/sync/queries"
import { applyGlobalProjectEvent } from "@/platform/sync/global-event-projector"
import { routeDirectoryEvent, type RoutableEvent } from "./event-router"
import {
  installSessionProjectionSelfHeal,
  retryUnsettledSessionProjectionPulls,
  scheduleSessionProjectionPull,
} from "@/platform/runtime/agent/session-projection"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { applyDirectoryEventToShellQueries } from "../../../features/session/data/sync/directory-event-projector"
import { applySessionStatusSseEvent } from "../../../features/session/store/session-status-dispatcher"
import { shouldInvalidateBootstrapFresh } from "../../../platform/sync/global-sync/bootstrap-fresh"
import { shouldRefreshChildrenForGlobalEvent } from "../../../platform/sync/global-sync/global-event-refresh-policy"
import type { ClaxedoEvent } from "../claxedo-events"

type GlobalEventSource = {
  listen: (handler: (event: { name: string; details: RoutableEvent }) => void) => () => void
}
type DirectoryRef = string
type GlobalProject = Parameters<typeof applyGlobalProjectEvent>[0]["project"][number]
type LifecycleSession = {
  id: string
  slug: string
  projectID: string
  directory: DirectoryRef
  title: string
  version: string
  time: { created: number; updated: number; archived?: number }
} & Record<string, unknown>

type ClaxedoEventType = ClaxedoEvent["type"]
type ClaxedoEventSource = {
  on: <T extends ClaxedoEventType>(
    type: T,
    handler: (event: Extract<ClaxedoEvent, { type: T }>) => void,
  ) => (() => void) | undefined
}

type DirectoryChildren = {
  directories: () => DirectoryRef[]
  has: (directory: DirectoryRef) => boolean
  mark: (directory: DirectoryRef) => void
  sessionCache: (directory: DirectoryRef) => DirectorySessionCacheValue
}

type SessionEventType = "created" | "updated" | "deleted"
type EventIngressInput = {
  globalEvents: GlobalEventSource
  claxedoEvents: ClaxedoEventSource | undefined
  projects: () => GlobalProject[]
  projectFor: (directory: DirectoryRef) => GlobalProject | undefined
  children: DirectoryChildren
  push: (directory: DirectoryRef) => void
  refresh: () => void
  setGlobalProject: Parameters<typeof applyGlobalProjectEvent>[0]["setGlobalProject"]
  sessionInventoryLoaded: () => boolean
  applySessionEvent: (info: LifecycleSession, type: SessionEventType) => void
  draftWasRolledBack: (draftId: string) => boolean
  cacheSessions: (directory: DirectoryRef, value: Omit<DirectorySessionCacheValue, "at">) => void
  sessionCacheLimit: (directory: DirectoryRef, fallback: number) => number
}

const claxedoDirectoryEventTypes = [
  "message.updated",
  "message.part.updated",
  "message.part.delta",
  "message.completed",
  "session.idle",
  "session.error",
  "session.status",
  "session.updated",
  "session.agent",
  "todo.updated",
  "permission.asked",
  "permission.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
  "session.diff",
  "session.compacted",
] as const

export function normalizeClaxedoSessionLifecycleEvent(
  event: Extract<ClaxedoEvent, { type: "session.lifecycle" }>,
): ClaxedoSessionLifecycleEvent | undefined {
  const info = readLifecycleSessionInfo(event.info, event.directory)
  if (event.phase === "created" && !info) return
  return {
    ...event,
    info,
  }
}

export function createGlobalSyncEventIngress(input: EventIngressInput) {
  const unsubscribeGlobal = input.globalEvents.listen((entry) => {
    const directory = entry.name
    const event = entry.details

    if (directory === "global") {
      applyGlobalProjectEvent({
        event,
        project: input.projects(),
        refresh: input.refresh,
        setGlobalProject: input.setGlobalProject,
      })
      if (shouldRefreshChildrenForGlobalEvent(event.type)) {
        for (const childDirectory of input.children.directories()) {
          input.push(childDirectory)
        }
      }
      return
    }

    const sessionEventType = globalSessionEventType(event)
    if (sessionEventType === "created") void invalidateSessionListQueries()
    if (input.sessionInventoryLoaded() && sessionEventType) {
      const raw = (event.properties as { info?: LifecycleSession }).info
      if (raw) {
        const info = { ...raw }
        if (!info.projectID && info.directory) {
          const project = input.projectFor(info.directory)
          if (project?.id) info.projectID = project.id
        }
        input.applySessionEvent(info, sessionEventType)
      }
    }

    if (!input.children.has(directory)) {
      applyDirectoryEventToShellQueries({ event, directory })
      applySessionStatusSseEvent({ event, directory })
      return
    }
    routeDirectoryEvent({
      event,
      directory,
      sinks: {
        schedule: (event) => {
          const projection = sessionProjectionEvent(event)
          const runtimeRef = projection ? sessionWorkspaceRuntimeRef({ directory, projects: input.projects() }) : undefined
          if (projection && runtimeRef) {
            void scheduleSessionProjectionPull({
              action: projection.action,
              reason: projection.reason,
              workspaceId: runtimeRef.workspaceId,
              sessionId: projection.sessionId,
              ...(projection.expectedEventOrdinal === undefined ? {} : { expectedEventOrdinal: projection.expectedEventOrdinal }),
              idempotencyKey: `${projection.reason}:${runtimeRef.workspaceId}:${projection.sessionId}:${projection.expectedEventOrdinal ?? Date.now()}`,
            })
          }
          if (shouldInvalidateBootstrapFresh(event.type)) input.push(directory)
        },
        mark: () => input.children.mark(directory),
        cache: () => input.children.sessionCache(directory),
        push: input.push,
        cacheSessions: (next) => {
          input.cacheSessions(directory, {
            limit: input.sessionCacheLimit(directory, next.limit),
            total: next.total,
            session: next.session,
          })
        },
      },
    })
  })

  const unsubscribeClaxedoLifecycle = input.claxedoEvents?.on("session.lifecycle", (event) => {
    const lifecycleEvent = normalizeClaxedoSessionLifecycleEvent(event)
    if (!lifecycleEvent) return
    // A lifecycle event proves the bus is live again — replay any sync-back
    // that previously exhausted its retries so a missed session still reaches
    // Convex (and therefore the sidebar) instead of being lost until reload.
    void retryUnsettledSessionProjectionPulls()
    applyClaxedoSessionLifecycleToSync(input, lifecycleEvent)
  })
  const unsubscribeClaxedoDirectoryEvents = claxedoDirectoryEventTypes
    .map((type) => input.claxedoEvents?.on(type, (event) => {
      applyClaxedoDirectoryEventToSync(input, event)
    }))
    .filter((cleanup): cleanup is () => void => !!cleanup)
  const detachProjectionSelfHeal = installSessionProjectionSelfHeal()

  return () => {
    unsubscribeGlobal()
    unsubscribeClaxedoLifecycle?.()
    unsubscribeClaxedoDirectoryEvents.forEach((cleanup) => cleanup())
    detachProjectionSelfHeal()
  }
}

function applyClaxedoDirectoryEventToSync(input: EventIngressInput, event: Extract<ClaxedoEvent, { type: typeof claxedoDirectoryEventTypes[number] }>) {
  const directory = event.directory
  if (!directory) return
  if (!input.children.has(directory)) {
    applyDirectoryEventToShellQueries({ event, directory })
    applySessionStatusSseEvent({ event, directory })
    return
  }
  routeDirectoryEvent({
    event,
    directory,
    sinks: {
      schedule: (event) => {
        const projection = sessionProjectionEvent(event)
        const runtimeRef = projection ? sessionWorkspaceRuntimeRef({ directory, projects: input.projects() }) : undefined
        if (projection && runtimeRef) {
          void scheduleSessionProjectionPull({
            action: projection.action,
            reason: projection.reason,
            workspaceId: runtimeRef.workspaceId,
            sessionId: projection.sessionId,
            ...(projection.expectedEventOrdinal === undefined ? {} : { expectedEventOrdinal: projection.expectedEventOrdinal }),
            idempotencyKey: `${projection.reason}:${runtimeRef.workspaceId}:${projection.sessionId}:${projection.expectedEventOrdinal ?? Date.now()}`,
          })
        }
        if (shouldInvalidateBootstrapFresh(event.type)) input.push(directory)
      },
      mark: () => input.children.mark(directory),
      cache: () => input.children.sessionCache(directory),
      push: input.push,
      cacheSessions: (next) => {
        input.cacheSessions(directory, {
          limit: input.sessionCacheLimit(directory, next.limit),
          total: next.total,
          session: next.session,
        })
      },
    },
  })
}

function applyClaxedoSessionLifecycleToSync(input: EventIngressInput, event: ClaxedoSessionLifecycleEvent) {
  if (event.phase === "created" && event.draftId && input.draftWasRolledBack(event.draftId)) return
  const next = applyClaxedoSessionLifecycleEvent({
    event,
    directory: event.directory,
    cache: input.children.sessionCache(event.directory),
    push: input.push,
  })
  if (!next) return
  input.children.mark(event.directory)
  if (event.phase !== "created" || !event.info) return
  const eventInfo = event.info as LifecycleSession
  const inventoryProjectID = input.projectFor(eventInfo.directory)?.id
  const info: LifecycleSession = inventoryProjectID
    ? { ...eventInfo, projectID: inventoryProjectID }
    : eventInfo
  // The rendered rail rows come from the paginated `session-list` query, which
  // this projection's cache write does not feed; refetch it so the newly
  // created session row appears without a reload (matches the flat-inventory
  // refresh `applySessionEvent` performs below).
  void invalidateSessionListQueries()
  upsertCreatedSessionListRow({
    row: {
      sessionId: info.id,
      title: info.title,
      directory: info.directory,
      projectId: info.projectID,
      ...(typeof info.workspaceID === "string" ? { workspaceId: info.workspaceID } : event.workspaceId ? { workspaceId: event.workspaceId } : {}),
      createdAt: info.time.created,
      updatedAt: info.time.updated,
    },
  })
  applySessionStatusSseEvent({
    directory: event.directory,
    event: { type: "session.idle", properties: { sessionID: info.id } },
  })
  input.cacheSessions(event.directory, {
    limit: input.sessionCacheLimit(event.directory, next.limit),
    total: next.total,
    session: next.session,
  })
  if (!input.sessionInventoryLoaded()) return
  input.applySessionEvent(info, "created")
}

function readLifecycleSessionInfo(input: unknown, directory: DirectoryRef): LifecycleSession | undefined {
  const value = input && typeof input === "object" ? input as Partial<LifecycleSession> : undefined
  if (!value) return
  if (typeof value.id !== "string") return
  if (typeof value.slug !== "string") return
  if (typeof value.projectID !== "string") return
  const sessionDirectory = typeof value.directory === "string" && value.directory ? value.directory : directory
  if (typeof value.title !== "string") return
  if (typeof value.version !== "string") return
  if (!value.time || typeof value.time.created !== "number" || typeof value.time.updated !== "number") return
  return { ...value, directory: sessionDirectory } as LifecycleSession
}

function sessionProjectionEvent(input: unknown) {
  const event = rec(input)
  const properties = rec(event?.properties)
  const info = rec(properties?.info)
  const part = rec(properties?.part)
  const type = txt(event?.type)
  const sessionId = txt(properties?.sessionID) ?? txt(properties?.sessionId) ?? txt(info?.sessionID) ?? txt(part?.sessionID)
  if (!type || !sessionId) return
  const ordinal = typeof event?.event_ordinal === "number" && Number.isFinite(event.event_ordinal)
    ? event.event_ordinal
    : undefined
  if (type === "message.completed" || type === "session.idle" || type === "session.error") {
    return {
      action: "checkpoint" as const,
      reason: "message-checkpoint" as const,
      sessionId,
      ...(ordinal === undefined ? {} : { expectedEventOrdinal: ordinal }),
    }
  }
  const replayGap = (type === "harness-notice" && txt(event?.code) === "runtime.sse_replay_gap") ||
    (type === "runtime.diagnostic" && txt(properties?.code) === "runtime.sse_replay_gap")
  if (replayGap) {
    return {
      action: "repair" as const,
      reason: "sse-gap" as const,
      sessionId,
      ...(ordinal === undefined ? {} : { expectedEventOrdinal: ordinal }),
    }
  }
  return undefined
}

function globalSessionEventType(event: RoutableEvent): SessionEventType | undefined {
  if (event.type === "session.created") return "created"
  if (event.type === "session.updated") return "updated"
  if (event.type === "session.deleted") return "deleted"
  return
}

function rec(input: unknown) {
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined
}

function txt(input: unknown) {
  return typeof input === "string" ? input : undefined
}
