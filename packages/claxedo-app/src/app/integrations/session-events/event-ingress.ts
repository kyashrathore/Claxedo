import { applyClaxedoSessionLifecycleEvent, type ClaxedoSessionLifecycleEvent } from "@/features/session/data/sync/session-list-events"
import {
  invalidateSessionShareQueries,
  reconcileUpdatedSessionListQueryData,
  removeSessionListQueryData,
  upsertCreatedSessionListRow,
} from "@/features/session/data/query/session-list"
import { removeSessionInventoryQueryData } from "@/features/session/data/sync/session-inventory"
import { sessionRowDirectory } from "@/features/session/data/sync/session-source"
import type { SessionInventoryRow } from "@/features/session/data/query/types"
import type { DirectorySessionCacheValue } from "../../../features/session/data/sync/queries"
import { applyGlobalProjectEvent } from "@/platform/sync/global-event-projector"
import { routeDirectoryEvent, type RoutableEvent } from "./event-router"
import {
  installSessionProjectionSelfHeal,
  retryUnsettledSessionProjectionPulls,
  scheduleSessionProjectionPull,
  sessionProjectionBacking,
} from "@/platform/runtime/agent/session-projection"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { applyDirectoryEventToShellQueries } from "../../../features/session/data/sync/directory-event-projector"
import { applySessionStatusSseEvent } from "../../../features/session/store/session-status-dispatcher"
import { shouldInvalidateBootstrapFresh } from "../../../platform/sync/global-sync/bootstrap-fresh"
import { shouldRefreshChildrenForGlobalEvent } from "../../../platform/sync/global-sync/global-event-refresh-policy"
import type { ClaxedoEvent } from "../claxedo-events"
import type {
  SessionTitleProjectionApi,
  SessionTitleTarget,
} from "@/features/session/store/session-title-projection"
import { prepareRegisteredSessionRevocation } from "@/features/session/conversation/conversation-registry"
import { allowPersistedSessionConversations } from "@/features/session/conversation/conversation-persistence"

export type SessionAccessRevokedEvent = { sessionId: string; workspaceId: string }

export type SessionAccessRevocationSource = {
  onSessionAccessRevoked: (listener: (event: SessionAccessRevokedEvent) => void) => () => void
}

export function createSessionAccessRevocationChannel() {
  const listeners = new Set<(event: SessionAccessRevokedEvent) => void>()
  return {
    publish(event: SessionAccessRevokedEvent) {
      for (const listener of listeners) listener(event)
    },
    subscribe(listener: (event: SessionAccessRevokedEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function createSessionAuthorityRevision() {
  let revision = 0
  return {
    capture(scopeIsCurrent: () => boolean) {
      const captured = revision
      return () => scopeIsCurrent() && captured === revision
    },
    invalidate() {
      revision++
    },
  }
}

/** Canonical successful inventory is also grant authority when doorbells miss. */
export function reconcileAuthorizedSessionPersistence(
  sessions: Iterable<{ id: string }>,
  scope: string,
) {
  for (const session of sessions) allowPersistedSessionConversations(session.id, scope)
}

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
type SessionTitleWriter = Pick<SessionTitleProjectionApi, "publishCanonical" | "remove">
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
  sessionTitles: SessionTitleWriter
  draftWasRolledBack: (draftId: string) => boolean
  cacheSessions: (directory: DirectoryRef, value: Omit<DirectorySessionCacheValue, "at">) => void
  sessionCacheLimit: (directory: DirectoryRef, fallback: number) => number
  sessionAccessRetained: (event: SessionAccessRevokedEvent) => Promise<boolean>
  revocationScope: () => string
  onSessionAuthorityChanged?: () => void
  onSessionAccessRevoked?: (event: SessionAccessRevokedEvent) => void
  flushNavigationPersistence: () => Promise<void>
  revocationRetryDelays?: readonly number[]
}

const DEFAULT_REVOCATION_RETRY_DELAYS = [50, 250, 1_000, 5_000] as const

async function retrySessionRevocationOperation<T>(
  operation: () => Promise<T>,
  shouldContinue: () => boolean,
  retryDelays: readonly number[] = DEFAULT_REVOCATION_RETRY_DELAYS,
): Promise<{ completed: true; value: T } | { completed: false }> {
  const delays = retryDelays.length > 0 ? retryDelays : DEFAULT_REVOCATION_RETRY_DELAYS
  for (let attempt = 0; shouldContinue(); attempt++) {
    try {
      return { completed: true, value: await operation() }
    } catch (error) {
      if (!shouldContinue()) return { completed: false }
      const delay = delays[Math.min(attempt, delays.length - 1)]!
      if (attempt === 0 || (attempt + 1) % 12 === 0) {
        console.error("Retrying revoked session reconciliation", error)
      }
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  return { completed: false }
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
  let disposed = false
  const revocationTokens = new Map<string, object>()
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
    const raw = sessionEventType
      ? (event.properties as { info?: LifecycleSession } | undefined)?.info
      : undefined
    if (sessionEventType && raw) {
      // The workspace's own stream is the authority for its list, so the frame
      // is APPLIED rather than used as a doorbell for a refetch: a created row
      // appears with no list request at all, and an updated title or timestamp
      // reorders in place.
      applySessionEventToSessionList({ info: raw, type: sessionEventType, directory, projects: input.projects() })
      projectCanonicalSessionTitle({
        writer: input.sessionTitles,
        info: raw,
        type: sessionEventType,
        directory,
      })
      // Central runtime events share the OpenCode compatibility stream for
      // transcript/title projection, but their `directory` is the runtime's
      // internal session key rather than a workspace directory. Their signed
      // control-plane inventory remains authoritative; inserting this frame
      // into workspace inventory invents a workspace keyed by the session id
      // and can replace the already-open central surface on a cold route.
      if (input.sessionInventoryLoaded() && !isCentralLifecycleSession(raw)) {
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
          const backing = projection
            ? sessionProjectionBacking(sessionWorkspaceRuntimeRef({ directory, projects: input.projects() }))
            : undefined
          if (projection && backing) {
            void scheduleSessionProjectionPull({
              action: projection.action,
              reason: projection.reason,
              workspaceId: backing.workspaceId,
              sessionId: projection.sessionId,
              ...(projection.expectedEventOrdinal === undefined ? {} : { expectedEventOrdinal: projection.expectedEventOrdinal }),
              idempotencyKey: `${projection.reason}:${backing.workspaceId}:${projection.sessionId}:${projection.expectedEventOrdinal ?? Date.now()}`,
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
  const unsubscribeClaxedoShareChanged = input.claxedoEvents?.on("session.share.changed", (event) => {
    // Doorbell only — control-plane list/inventory already include shares.
    // A base-page list refetch deliberately preserves cached pagination tails,
    // so revocation must first evict the now-forbidden row. The subsequent
    // authoritative refetch reconciles every remaining field and can restore
    // the row if another independent grant still permits access.
    input.onSessionAuthorityChanged?.()
    const scope = input.revocationScope()
    const key = `${scope}\0${event.workspaceId}\0${event.sessionId}`
    if (event.phase === "revoked") {
      const revoked = { sessionId: event.sessionId, workspaceId: event.workspaceId }
      const token = {}
      revocationTokens.set(key, token)
      void handleSessionShareRevoked(
        input,
        revoked,
        scope,
        () => !disposed && input.revocationScope() === scope && revocationTokens.get(key) === token,
      ).finally(() => {
        if (revocationTokens.get(key) === token) revocationTokens.delete(key)
      })
      return
    }
    // A newer grant supersedes any in-flight revoke, including one waiting for
    // durable storage recovery. Its token can no longer publish a stale access
    // loss or redirect the now-authorized principal.
    revocationTokens.delete(key)
    reconcileAuthorizedSessionPersistence([{ id: event.sessionId }], scope)
    void invalidateSessionShareQueries().catch(() => undefined)
  })
  const unsubscribeClaxedoDirectoryEvents = claxedoDirectoryEventTypes
    .map((type) => input.claxedoEvents?.on(type, (event) => {
      applyClaxedoDirectoryEventToSync(input, event)
    }))
    .filter((cleanup): cleanup is () => void => !!cleanup)
  const detachProjectionSelfHeal = installSessionProjectionSelfHeal()

  return () => {
    disposed = true
    unsubscribeGlobal()
    unsubscribeClaxedoLifecycle?.()
    unsubscribeClaxedoShareChanged?.()
    unsubscribeClaxedoDirectoryEvents.forEach((cleanup) => cleanup())
    detachProjectionSelfHeal()
  }
}

async function handleSessionShareRevoked(
  input: EventIngressInput,
  event: SessionAccessRevokedEvent,
  scope: string,
  isActive: () => boolean,
) {
  try {
    // A share doorbell names one changed grant. Effective access is the union
    // of owner/participant/direct/org/team grants, so only a fresh authority
    // read can prove that the user lost the session.
    const access = await retrySessionRevocationOperation(
      () => input.sessionAccessRetained(event),
      isActive,
      input.revocationRetryDelays,
    )
    if (!access.completed) return
    if (access.value) {
      reconcileAuthorizedSessionPersistence([{ id: event.sessionId }], scope)
      return
    }

    // The authority read is asynchronous. If identity changed while it was in
    // flight, this event belongs to the old principal and must not touch the
    // new principal's memory, navigation, or durable transcript.
    if (!isActive()) return

    removeSessionListQueryData(event)
    removeSessionInventoryQueryData<SessionInventoryRow>({
      session: { id: event.sessionId, workspaceId: event.workspaceId },
    })
    // First prove the shared query persister is writable. A storage outage can
    // last long enough for access to be regranted; do not destroy conversation
    // state while waiting for that outage to recover.
    const persistenceReady = await retrySessionRevocationOperation(
      input.flushNavigationPersistence,
      isActive,
      input.revocationRetryDelays,
    )
    if (!persistenceReady.completed) return

    const accessBeforePurge = await retrySessionRevocationOperation(
      () => input.sessionAccessRetained(event),
      isActive,
      input.revocationRetryDelays,
    )
    if (!accessBeforePurge.completed) return
    if (accessBeforePurge.value) {
      reconcileAuthorizedSessionPersistence([{ id: event.sessionId }], scope)
      return
    }

    const purgeConversation = prepareRegisteredSessionRevocation(event.sessionId, scope)
    const durablePurge = await retrySessionRevocationOperation(
      purgeConversation.purgePersisted,
      isActive,
      input.revocationRetryDelays,
    )
    if (!durablePurge.completed) return

    // Recipient fanout is fail-soft, so a regrant doorbell may be missed. The
    // canonical authority read closes that gap before any in-memory state is
    // destroyed, while the token closes the normal delivered-doorbell race.
    const accessAfterDurablePurge = await retrySessionRevocationOperation(
      () => input.sessionAccessRetained(event),
      isActive,
      input.revocationRetryDelays,
    )
    if (!accessAfterDurablePurge.completed) return
    if (accessAfterDurablePurge.value) {
      reconcileAuthorizedSessionPersistence([{ id: event.sessionId }], scope)
      return
    }

    purgeConversation.purgeMemory()
    const persisted = await retrySessionRevocationOperation(
      input.flushNavigationPersistence,
      isActive,
      input.revocationRetryDelays,
    )
    if (!persisted.completed) return

    const finalAccess = await retrySessionRevocationOperation(
      () => input.sessionAccessRetained(event),
      isActive,
      input.revocationRetryDelays,
    )
    if (!finalAccess.completed) return
    if (finalAccess.value) {
      reconcileAuthorizedSessionPersistence([{ id: event.sessionId }], scope)
      return
    }
    if (isActive()) input.onSessionAccessRevoked?.(event)
  } catch (error) {
    // Defensive guard for programmer errors outside the retryable authority and
    // persistence operations. Never redirect after incomplete durable cleanup.
    console.error("Failed to reconcile revoked session access", error)
  } finally {
    await invalidateSessionShareQueries().catch((error) => {
      console.error("Failed to refresh session shares after access change", error)
    })
  }
}

function applyClaxedoDirectoryEventToSync(input: EventIngressInput, event: Extract<ClaxedoEvent, { type: typeof claxedoDirectoryEventTypes[number] }>) {
  const directory = event.directory
  if (!directory) return
  if (event.type === "session.updated") {
    const info = (event.properties as { info?: LifecycleSession } | undefined)?.info
    if (info) {
      projectCanonicalSessionTitle({
        writer: input.sessionTitles,
        info,
        type: "updated",
        directory,
        // The bridged auto-title frame's `info` names no workspaceID, but the
        // frame itself is workspace-stamped. Without this the canonical title
        // lands only under the directory key, and a rail row attributed to the
        // workspace (created-event rows carry `workspaceID`) keeps resolving
        // the stale canonical published under its workspace key at create
        // time — the session.lifecycle path below already passes it.
        ...(event.workspaceId ? { workspaceId: event.workspaceId } : {}),
      })
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
        const backing = projection
          ? sessionProjectionBacking(sessionWorkspaceRuntimeRef({ directory, projects: input.projects() }))
          : undefined
        if (projection && backing) {
          void scheduleSessionProjectionPull({
            action: projection.action,
            reason: projection.reason,
            workspaceId: backing.workspaceId,
            sessionId: projection.sessionId,
            ...(projection.expectedEventOrdinal === undefined ? {} : { expectedEventOrdinal: projection.expectedEventOrdinal }),
            idempotencyKey: `${projection.reason}:${backing.workspaceId}:${projection.sessionId}:${projection.expectedEventOrdinal ?? Date.now()}`,
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
  if (event.phase === "created" && event.info) {
    projectCanonicalSessionTitle({
      writer: input.sessionTitles,
      info: event.info,
      type: "created",
      directory: event.directory,
      workspaceId: event.workspaceId,
    })
  }
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
  const workspaceId = addressedWorkspaceId(
    typeof info.workspaceID === "string" ? info.workspaceID : event.workspaceId,
    input.projects(),
  )
  upsertCreatedSessionListRow({
    row: {
      sessionId: info.id,
      title: info.title,
      directory: sessionRowDirectory({ workspaceId, hostDirectory: info.directory }),
      projectId: info.projectID,
      ...(workspaceId ? { workspaceId } : {}),
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

/**
 * The workspace a session row is ADDRESSED by, or nothing.
 *
 * A minted `ws_*` id is self-identifying. A caller-chosen id is not: a machine
 * publishes its own LOCAL workspace under the id it already held, and the
 * control plane stores that id verbatim (`registerLocalForSharing`), so the
 * SAME uuid shape names a user-hosted workspace on one machine and a purely
 * local association on another. The resolved project catalog is the authority
 * for that distinction and `sessionWorkspaceRuntimeRef` is its reader: it
 * answers with the workspace's real kind, and `undefined` both for one the
 * catalog knows as local and for one it has never heard of. Failing closed
 * there is what keeps a local session's row from gaining a `workspace:<uuid>`
 * twin beside its `local:<dir>` row.
 */
function addressedWorkspaceId(value: string | undefined, projects: GlobalProject[]) {
  if (!value) return undefined
  if (/^ws_/.test(value)) return value
  return sessionWorkspaceRuntimeRef({ directory: `workspace:${value}`, projects })?.workspaceId
}

/**
 * A workspace stream's `session.created/updated/deleted` frame, applied to the
 * rendered list.
 *
 * The frame carries the whole row, so nothing here needs the server: created
 * prepends it, updated reconciles title and `time.updated` (and re-sorts a
 * `updated_desc` view), deleted removes it. Every source writes the same
 * `shell.sessionList` entry, so one applier covers the daemon's stream, the
 * control plane's, and a user-hosted workspace's runtime over the relay.
 */
function applySessionEventToSessionList(input: {
  info: LifecycleSession
  type: SessionEventType
  directory: DirectoryRef
  projects: GlobalProject[]
}) {
  const workspaceId = addressedWorkspaceId(
    txt(input.info.workspaceID) ?? txt(input.info.workspaceId),
    input.projects,
  )
  const directory = sessionRowDirectory({
    workspaceId,
    hostDirectory: input.info.directory || input.directory,
  })
  const identity = {
    sessionId: input.info.id,
    directory,
    ...(workspaceId ? { workspaceId } : {}),
  }
  if (input.type === "deleted") {
    removeSessionListQueryData(identity)
    return
  }
  if (input.type === "updated") {
    reconcileUpdatedSessionListQueryData({
      ...identity,
      title: input.info.title,
      updatedAt: input.info.time.updated,
    })
    return
  }
  upsertCreatedSessionListRow({
    row: {
      sessionId: input.info.id,
      title: input.info.title,
      directory,
      projectId: input.info.projectID,
      ...(workspaceId ? { workspaceId } : {}),
      createdAt: input.info.time.created,
      updatedAt: input.info.time.updated,
    },
  })
}

function projectCanonicalSessionTitle(input: {
  writer: SessionTitleWriter
  info: unknown
  type: SessionEventType
  directory: DirectoryRef
  workspaceId?: string
}) {
  const info = rec(input.info)
  const sessionId = txt(info?.id) ?? txt(info?.sessionID)
  if (!sessionId) return
  const workspaceId = txt(info?.workspaceID) ?? txt(info?.workspaceId) ?? input.workspaceId
  const target: SessionTitleTarget = {
    sessionId,
    directory: txt(info?.directory) ?? input.directory,
    ...(workspaceId ? { workspaceId } : {}),
  }
  if (input.type === "deleted") {
    input.writer.remove(target)
    return
  }
  const title = txt(info?.title)
  if (!title) return
  const time = rec(info?.time)
  const updatedAt = num(time?.updated) ?? num(info?.updatedAt)
  input.writer.publishCanonical({
    ...target,
    title,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  })
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

function isCentralLifecycleSession(input: LifecycleSession) {
  return input.host === "central" ||
    (typeof input.sessionRef === "string" && input.sessionRef.startsWith("central:"))
}

function rec(input: unknown) {
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined
}

function txt(input: unknown) {
  return typeof input === "string" ? input : undefined
}

function num(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}
