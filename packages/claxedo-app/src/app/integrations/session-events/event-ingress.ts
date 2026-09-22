import { applyClaxedoSessionLifecycleEvent, type ClaxedoSessionLifecycleEvent } from "@/features/session/data/sync/session-list-events"
import { sessionRowDirectory } from "@/platform/identity/workspace-address"
import {
  invalidateSessionShareQueries,
  reconcileUpdatedSessionListQueryData,
  removeSessionListQueryData,
  upsertCreatedSessionListRow,
} from "@/features/session/data/query/session-list"
import { removeSessionInventoryQueryData } from "@/features/session/data/sync/session-inventory"
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
import { asRecord, readField, readString } from "@/lib/record"
import { sessionEventRow } from "@/features/session/data/sync/session-event-info"
import { asFiniteNumber, asString } from "@claxedo/helpers/guards"
import { captureException } from "@/platform/telemetry/analytics"

export type SessionAccessRevokedEvent = { sessionId: string; workspaceId: string }

export type SessionAccessRevocationSource = {
  onSessionAccessRevoked: (listener: (event: SessionAccessRevokedEvent) => void) => () => void
}

export function createSessionAccessRevocationChannel() {
  const listeners = new Set<(event: SessionAccessRevokedEvent) => void>()
  return {
    publish: (event: SessionAccessRevokedEvent) => {
      for (const listener of listeners) listener(event)
    },
    subscribe: (listener: (event: SessionAccessRevokedEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function createSessionAuthorityRevision() {
  let revision = 0
  return {
    capture: (scopeIsCurrent: () => boolean) => {
      const captured = revision
      return () => scopeIsCurrent() && captured === revision
    },
    invalidate: () => {
      revision++
    },
  }
}

/** Canonical successful inventory is also grant authority when doorbells miss. */
export function reconcileAuthorizedSessionPersistence(
  sessions: Iterable<{ id: string }>,
  scope: string | null,
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

/**
 * The `session.*` row `session-event-info` produces once it has READ the frame.
 *
 * Named off that reader rather than restated here: it is the module that owns
 * the difference between the producers' `info` shapes, and three sites in this
 * file used to assert `event.properties as { info?: LifecycleSession }` instead
 * of reading through it — a claim that was false for every `session.deleted`
 * frame (identity only) and for the auto-title `session.updated` frames, which
 * name no `slug`, `version` or `projectID` at all.
 */
type SessionEventRow = NonNullable<ReturnType<typeof sessionEventRow>>

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
  applySessionEvent: (info: SessionEventRow, type: SessionEventType) => void
  sessionTitles: SessionTitleWriter
  draftWasRolledBack: (draftId: string) => boolean
  cacheSessions: (directory: DirectoryRef, value: Omit<DirectorySessionCacheValue, "at">) => void
  sessionCacheLimit: (directory: DirectoryRef, fallback: number) => number
  sessionAccessRetained: (event: SessionAccessRevokedEvent) => Promise<boolean>
  revocationScope: () => string | null
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
      const delay = delays[Math.min(attempt, delays.length - 1)]
      if (attempt === 0 || (attempt + 1) % 12 === 0) {
        captureException(error, { surface: "session", operation: "revoked-session-reconciliation", attempt })
      }
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  return { completed: false }
}


export function normalizeClaxedoSessionLifecycleEvent(
  event: Extract<ClaxedoEvent, { type: "session.lifecycle" }>,
): ClaxedoSessionLifecycleEvent | undefined {
  const info = readLifecycleSessionInfo(event.info, event.directory)
  if (event.phase === "created" && !info) return undefined
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
    if (sessionEventType) {
      // A frame that names ordering timestamps is a row; one that does not (a
      // `session.deleted`, which carries identity only) still addresses a row.
      // Both readings come from `session-event-info`, so the two kinds of frame
      // are distinguished once here rather than asserted into one shape.
      const row = sessionEventRow(event.properties)
      // The workspace's own stream is the authority for its list, so the frame
      // is APPLIED rather than used as a doorbell for a refetch: a created row
      // appears with no list request at all, and an updated title or timestamp
      // reorders in place.
      applySessionEventToSessionList({
        properties: event.properties,
        row,
        type: sessionEventType,
        directory,
        projects: input.projects(),
      })
      projectCanonicalSessionTitle({
        writer: input.sessionTitles,
        info: readField(event.properties, "info"),
        type: sessionEventType,
        directory,
        workspaceId: asString(readField(event, "workspaceId")),
      })
      // A `central:`-ref'd session's frames carry the runtime's internal
      // session key as `directory`, not a workspace directory. Its signed
      // control-plane inventory stays authoritative; inserting this frame
      // into the workspace inventory would invent a workspace keyed by the
      // session id and could replace the already-open surface on a cold route.
      if (row && input.sessionInventoryLoaded() && !isCentralSessionRow(row)) {
        const info = { ...row }
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
    // the control plane (and therefore the sidebar) instead of being lost until reload.
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
  // The control plane's own inventory changed for a workspace whose stream
  // this surface may not hold open (a session created from the CLI while the
  // rail sits on the home route): the doorbell names the workspace only, and
  // the reads it provokes apply access.
  const unsubscribeClaxedoInventoryChanged = input.claxedoEvents?.on("session.inventory.changed", () => {
    void invalidateSessionShareQueries().catch(() => undefined)
  })
  const detachProjectionSelfHeal = installSessionProjectionSelfHeal()

  return () => {
    disposed = true
    unsubscribeGlobal()
    unsubscribeClaxedoLifecycle?.()
    unsubscribeClaxedoShareChanged?.()
    unsubscribeClaxedoInventoryChanged?.()
    detachProjectionSelfHeal()
  }
}

async function handleSessionShareRevoked(
  input: EventIngressInput,
  event: SessionAccessRevokedEvent,
  scope: string | null,
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
    removeSessionInventoryQueryData({
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
    captureException(error, { surface: "session", operation: "revoked-session-access" })
  } finally {
    await invalidateSessionShareQueries().catch((error) => {
      captureException(error, { surface: "session", operation: "session-shares-refresh" })
    })
  }
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
  const eventInfo = readLifecycleSessionInfo(event.info, event.directory)
  if (!eventInfo) return
  const inventoryProjectID = input.projectFor(eventInfo.directory)?.id
  const info: LifecycleSession = inventoryProjectID
    ? { ...eventInfo, projectID: inventoryProjectID }
    : eventInfo
  const workspaceId = addressedWorkspaceId(
    typeof info.workspaceID === "string" ? info.workspaceID : event.workspaceId,
    input.projects(),
  )
  if (txt(info.parentID)) {
    removeSessionListQueryData({
      sessionId: info.id,
      directory: sessionRowDirectory({ workspaceId, hostDirectory: info.directory }),
      ...(workspaceId ? { workspaceId } : {}),
    })
  } else {
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
  }
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
 * SAME uuid shape names a machine-placed workspace on one machine and a purely
 * local association on another. The resolved project catalog is the authority
 * for that distinction and `sessionWorkspaceRuntimeRef` is its reader: it
 * answers with the workspace's real kind, and `undefined` both for one the
 * catalog knows as local and for one it has never heard of. Failing closed
 * there is what keeps a local session's row from gaining a `workspace:<uuid>`
 * twin beside its `local:<dir>` row.
 */
function addressedWorkspaceId(value: string | undefined, projects: GlobalProject[]) {
  if (!value) return undefined
  if (value.startsWith('ws_')) return value
  return sessionWorkspaceRuntimeRef({ directory: `workspace:${value}`, projects })?.workspaceId
}

/**
 * A workspace stream's `session.updated`/`session.deleted` frame — or the row a
 * `session.lifecycle` "created" carries — applied to the rendered list.
 *
 * The frame carries the whole row, so nothing here needs the server: created
 * prepends it, updated reconciles title and `time.updated` (and re-sorts a
 * `updated_desc` view), deleted removes it. Every source writes the same
 * `shell.sessionList` entry, so one applier covers the daemon's stream, the
 * control plane's, and a machine-placed workspace's runtime over the relay.
 */
function applySessionEventToSessionList(input: {
  properties: unknown
  row: SessionEventRow | undefined
  type: SessionEventType
  directory: DirectoryRef
  projects: GlobalProject[]
}) {
  // Identity is read off the frame rather than the row: a `session.deleted`
  // names only `{ id, parentID?, directory? }` and still has to remove its row.
  const info = asRecord(readField(input.properties, "info"))
  const sessionId = txt(info?.id)
  if (!sessionId) return
  const workspaceId = addressedWorkspaceId(
    txt(info?.workspaceID) ?? txt(info?.workspaceId),
    input.projects,
  )
  const directory = sessionRowDirectory({
    workspaceId,
    hostDirectory: txt(info?.directory) || input.directory,
  })
  const identity = {
    sessionId,
    directory,
    ...(workspaceId ? { workspaceId } : {}),
  }
  if (input.type === "deleted" || txt(info?.parentID)) {
    removeSessionListQueryData(identity)
    return
  }
  // Placing or re-sorting a row needs its ordering timestamps, which is exactly
  // what makes a frame a row.
  const row = input.row
  if (!row) return
  if (input.type === "updated") {
    reconcileUpdatedSessionListQueryData({
      ...identity,
      title: row.title,
      updatedAt: row.time.updated,
    })
    return
  }
  upsertCreatedSessionListRow({
    row: {
      sessionId,
      title: row.title,
      directory,
      projectId: row.projectID,
      ...(workspaceId ? { workspaceId } : {}),
      createdAt: row.time.created,
      updatedAt: row.time.updated,
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
  const info = asRecord(input.info)
  const sessionId = asString(info?.id) ?? asString(info?.sessionID)
  if (!sessionId) return
  const workspaceId = asString(info?.workspaceID) ?? asString(info?.workspaceId) ?? input.workspaceId
  const target: SessionTitleTarget = {
    sessionId,
    directory: asString(info?.directory) ?? input.directory,
    ...(workspaceId ? { workspaceId } : {}),
  }
  if (input.type === "deleted") {
    input.writer.remove(target)
    return
  }
  const title = asString(info?.title)
  if (!title) return
  const time = asRecord(info?.time)
  const updatedAt = asFiniteNumber(time?.updated) ?? asFiniteNumber(info?.updatedAt)
  input.writer.publishCanonical({
    ...target,
    title,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  })
}

function readLifecycleSessionInfo(input: unknown, directory: DirectoryRef): LifecycleSession | undefined {
  const value = asRecord(input)
  if (!value) return undefined
  const id = txt(value.id)
  const slug = txt(value.slug)
  const projectID = txt(value.projectID)
  const title = txt(value.title)
  const version = txt(value.version)
  const time = asRecord(value.time)
  const created = asFiniteNumber(time?.created)
  const updated = asFiniteNumber(time?.updated)
  const archived = asFiniteNumber(time?.archived)
  if (id === undefined || slug === undefined || projectID === undefined) return undefined
  if (title === undefined || version === undefined) return undefined
  if (created === undefined || updated === undefined) return undefined
  return {
    ...value,
    id,
    slug,
    projectID,
    directory: txt(value.directory) || directory,
    title,
    version,
    time: { created, updated, ...(archived === undefined ? {} : { archived }) },
  }
}

function sessionProjectionEvent(input: unknown) {
  const event = asRecord(input)
  const properties = asRecord(event?.properties)
  const info = asRecord(properties?.info)
  const part = asRecord(properties?.part)
  const type = asString(event?.type)
  const sessionId = asString(properties?.sessionID) ?? asString(properties?.sessionId) ?? asString(info?.sessionID) ?? asString(part?.sessionID)
  if (!type || !sessionId) return undefined
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
  return undefined
}

function globalSessionEventType(event: RoutableEvent): SessionEventType | undefined {
  if (event.type === "session.updated") return "updated"
  if (event.type === "session.deleted") return "deleted"
  return undefined
}

function isCentralSessionRow(input: SessionEventRow) {
  return readString(input, "sessionRef")?.startsWith("central:") ?? false
}

function txt(input: unknown) {
  return typeof input === "string" ? input : undefined
}
