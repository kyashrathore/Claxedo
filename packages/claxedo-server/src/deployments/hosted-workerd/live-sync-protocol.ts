import type { EventScopePrincipal } from "@claxedo/server-core/platform/http/event-visibility"
import type { ControlPlaneAuthContext } from "@claxedo/server-core/platform/auth/auth"
import { liveSyncRoomNameForPrincipal } from "../../platform/http/live-sync-publish"

export const SSE_QUEUE_LIMIT = 32
export const HEARTBEAT: { type: "heartbeat" } = { type: "heartbeat" }

// The room receives the resolved caller identity from the Worker (a trusted
// internal DO fetch — DOs are unreachable from outside the Worker), so it can
// apply `eventVisibleTo` per held connection without re-verifying the bearer.
// `x-livesync-org` carries the authority-internal org id resolved at connect
// (`authority.resolveOrgId`), matching the namespace events are stamped
// with — never the raw identity-provider org claim (see `EventScopePrincipal`).
const HEADER_MODE = "x-livesync-mode"
const HEADER_SUBJECT = "x-livesync-subject"
const HEADER_ORG = "x-livesync-org"
export const HEADER_HEARTBEAT_MS = "x-livesync-heartbeat-ms"
/** The client's SSE `Last-Event-ID`, forwarded on the internal connect fetch. */
export const HEADER_LAST_EVENT_ID = "x-livesync-last-event-id"
/**
 * Response header on the room's `/connect` reply carrying the cursor this
 * connection resumes from. The bridge cannot compute it: for a cursor-less
 * client the resume point is the room's own `lastId()`, which only the room
 * knows, and getting it wrong is the difference between "everything from now
 * on" and "re-deliver the whole retained log on the next reconnect".
 */
export const HEADER_CURSOR = "x-livesync-cursor"

/** Structural type of the CF `DurableObjectState` bits the room touches. */
export type LiveSyncSocket = EventTarget & {
  accept?: () => void
  send(data: string): void
  close(code?: number, reason?: string): void
  serializeAttachment?(attachment: LiveSyncSocketAttachment): void
  deserializeAttachment?(): LiveSyncSocketAttachment | undefined
  bufferedAmount?: number
}

type LiveSyncSocketAttachment = {
  principal: EventScopePrincipal
}

/**
 * The resolved subscriber a live-sync connection is held for. `auth` is the
 * verified control-plane context (the identity provider claims — used only for heartbeat
 * reauthorization comparisons); `orgId` is the authority-internal org id
 * resolved via `authority.resolveOrgId(auth)` at connect time, the identity
 * rooms are named with and `eventVisibleTo` scopes on. Absent `orgId` (no
 * authority composed) degrades to the subject-keyed owner room, where
 * org-scoped events stay invisible fail-closed.
 */
export type LiveSyncSubscriber = {
  auth: ControlPlaneAuthContext
  orgId?: string
}

/** Build the per-connection scope principal from the trusted internal headers. */
export function roomPrincipalFromHeaders(headers: Headers): EventScopePrincipal {
  const mode = headers.get(HEADER_MODE)
  if (mode !== "signed") return { mode: "unsigned-local" }
  const orgId = headers.get(HEADER_ORG) ?? undefined
  return {
    mode: "signed",
    subject: headers.get(HEADER_SUBJECT) ?? "",
    ...(orgId ? { orgId } : {}),
  }
}

/**
 * Derive the DO room name from a resolved subscriber. A subscriber joins the
 * room of their active org — named by the authority-internal org id resolved
 * at connect — where a share publisher with that org nudges; the
 * per-connection `eventVisibleTo` filter narrows each notice to its
 * recipient. Signed callers with no resolved org, and unsigned-local/loopback,
 * key by subject.
 */
export function liveSyncRoomName(subscriber: LiveSyncSubscriber): string {
  if (subscriber.auth.mode !== "signed") return "owner:local"
  return liveSyncRoomNameForPrincipal({
    ownerUserId: subscriber.auth.user.subject,
    orgId: subscriber.orgId,
  })
}

/** Serialize the resolved identity into the trusted internal-fetch headers. */
export function liveSyncRoomConnectHeaders(
  subscriber: LiveSyncSubscriber,
  heartbeatMs?: number,
  lastEventId?: string,
): Record<string, string> {
  const headers: Record<string, string> = { accept: "text/event-stream" }
  if (subscriber.auth.mode === "signed") {
    headers[HEADER_MODE] = "signed"
    headers[HEADER_SUBJECT] = subscriber.auth.user.subject
    if (subscriber.orgId) headers[HEADER_ORG] = subscriber.orgId
  } else {
    headers[HEADER_MODE] = "unsigned-local"
  }
  if (heartbeatMs && Number.isFinite(heartbeatMs) && heartbeatMs > 0) {
    headers[HEADER_HEARTBEAT_MS] = String(Math.floor(heartbeatMs))
  }
  // The header value is forwarded unchanged. The bearer is not re-verified
  // inside the room, but the cursor is not an authorization input: every
  // replayed frame still clears `eventVisibleTo` against the identity in the
  // headers above, so a forged cursor can only change which of the caller's
  // own frames it receives.
  if (lastEventId) headers[HEADER_LAST_EVENT_ID] = lastEventId
  return headers
}

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-store",
  Connection: "keep-alive",
} as const
