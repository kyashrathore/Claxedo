/**
 * Who a live-sync connection is held for, and how that identity travels from
 * the Worker that verified it to the room that scopes on it.
 *
 * The room receives the resolved caller identity from the Worker (a trusted
 * internal DO fetch — DOs are unreachable from outside the Worker), so it can
 * apply `eventVisibleTo` per held connection without re-verifying anything.
 * `x-livesync-org` carries the authority-internal org id resolved at connect
 * (`authority.resolveOrgId`), matching the namespace events are stamped
 * with — never the raw identity-provider org claim (see `EventScopePrincipal`).
 */

import type { ControlPlaneAuthContext } from "@claxedo/server-core/platform/auth/auth"
import type { EventScopePrincipal } from "@claxedo/server-core/platform/http/event-visibility"
import { liveSyncRoomNameForPrincipal } from "../../platform/http/live-sync-publish"

export const HEADER_MODE = "x-livesync-mode"
export const HEADER_SUBJECT = "x-livesync-subject"
export const HEADER_ORG = "x-livesync-org"
/** The host a machine subscriber's own key verified for. */
export const HEADER_HOST = "x-livesync-host"
export const HEADER_HEARTBEAT_MS = "x-livesync-heartbeat-ms"
/** The client's SSE `Last-Event-ID`, forwarded on the internal connect fetch. */
export const HEADER_LAST_EVENT_ID = "x-livesync-last-event-id"

/**
 * A person's resolved subscriber. `auth` is the verified control-plane context
 * (the identity provider claims — used only for heartbeat reauthorization
 * comparisons); `orgId` is the authority-internal org id resolved via
 * `authority.resolveOrgId(auth)` at connect time, the identity rooms are
 * named with and `eventVisibleTo` scopes on. Absent `orgId` (no authority
 * composed) degrades to the subject-keyed owner room, where org-scoped events
 * stay invisible fail-closed.
 */
export type LiveSyncPersonSubscriber = {
  auth: ControlPlaneAuthContext
  orgId?: string
}

/**
 * A machine holding its doorbell with its own key (`claxedo connect`, the
 * desktop's connector child). It joins its enrolling owner's room, where the
 * host routes ring `host.changed` for it, and hears nothing else there.
 */
export type LiveSyncMachineSubscriber = {
  machine: { hostId: string; ownerUserId: string }
}

export type LiveSyncSubscriber = LiveSyncPersonSubscriber | LiveSyncMachineSubscriber

export function isMachineSubscriber(subscriber: LiveSyncSubscriber): subscriber is LiveSyncMachineSubscriber {
  return "machine" in subscriber
}

/** Build the per-connection scope principal from the trusted internal headers. */
export function roomPrincipalFromHeaders(headers: Headers): EventScopePrincipal {
  const mode = headers.get(HEADER_MODE)
  if (mode === "machine") return { mode: "machine", hostId: headers.get(HEADER_HOST) ?? "" }
  if (mode !== "signed") return { mode: "unsigned-local" }
  const orgId = headers.get(HEADER_ORG) ?? undefined
  return {
    mode: "signed",
    subject: headers.get(HEADER_SUBJECT) ?? "",
    ...(orgId ? { orgId } : {}),
  }
}

/** One replay ring per identity: every connection of the same principal shares a cursor sequence. */
export function replayPrincipalKey(principal: EventScopePrincipal) {
  if (principal.mode === "unsigned-local") return "local"
  if (principal.mode === "machine") return `machine:${principal.hostId}`
  return `signed:${principal.orgId ?? ""}:${principal.subject}`
}

/**
 * Derive the DO room name from a resolved subscriber. A person joins the room
 * of their active org — named by the authority-internal org id resolved at
 * connect — where a share publisher with that org nudges; the per-connection
 * `eventVisibleTo` filter narrows each notice to its recipient. Signed callers
 * with no resolved org, unsigned-local/loopback, and machines key by subject:
 * a machine belongs to the person who enrolled it, whatever org that person
 * is active in, and the host routes ring the owner room by that subject.
 */
export function liveSyncRoomName(subscriber: LiveSyncSubscriber): string {
  if (isMachineSubscriber(subscriber)) return liveSyncRoomNameForPrincipal({ ownerUserId: subscriber.machine.ownerUserId })
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
  if (isMachineSubscriber(subscriber)) {
    headers[HEADER_MODE] = "machine"
    headers[HEADER_HOST] = subscriber.machine.hostId
  } else if (subscriber.auth.mode === "signed") {
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

/** Whether a reauthorization resolved the same identity the stream was opened for. */
export function sameSubscriber(left: LiveSyncSubscriber, right: LiveSyncSubscriber) {
  if (isMachineSubscriber(left) || isMachineSubscriber(right)) {
    return isMachineSubscriber(left) && isMachineSubscriber(right)
      && left.machine.hostId === right.machine.hostId && left.machine.ownerUserId === right.machine.ownerUserId
  }
  if (left.auth.mode !== right.auth.mode) return false
  if (left.auth.mode === "unsigned-local" || right.auth.mode === "unsigned-local") return true
  if (left.auth.user.subject !== right.auth.user.subject) return false
  return left.auth.user.orgId === right.auth.user.orgId && left.orgId === right.orgId
}
