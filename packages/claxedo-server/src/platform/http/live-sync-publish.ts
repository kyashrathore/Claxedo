import type { ClaxedoEvent } from "../runtime/lib/bus"

/**
 * The PUBLISHER half of live-sync: naming a room and nudging it.
 *
 * The room itself is a Durable Object and stays in the hosted-workerd
 * deployment. Everything here is what a publisher needs — hosts and domains
 * that ring the doorbell — and it is deliberately structural: the namespace is
 * described by the two methods actually called, not by `DurableObjectNamespace`,
 * so a caller outside a Workers runtime can hold one.
 *
 * Keeping this out of the `.cf.ts` module is what lets `hosts/` publish without
 * importing a deployment.
 */

export interface LiveSyncRoomStub {
  fetch(request: Request): Promise<Response>
}

export interface LiveSyncRoomNamespace {
  idFromName(name: string): unknown
  get(id: unknown): LiveSyncRoomStub
}

const LIVE_SYNC_ROOM_NAME_PATTERN = /^(?:org|owner):(.*)$/

function requireRoomSegment(value: string | undefined, description: string): string {
  const segment = value?.trim()
  if (!segment || segment === "undefined" || segment === "null") {
    throw new Error(`live-sync room ${description} is invalid: ${JSON.stringify(value)}`)
  }
  return segment
}

/**
 * The room name for a principal. `orgId` here is the AUTHORITY-INTERNAL org id
 * that `connectLiveSyncRoom` keys subscribers with — Clerk org claims
 * (`org_...`) are a different namespace, and passing one names a room nobody
 * ever joins.
 *
 * Throws rather than returning a broken name: a template over a missing field
 * yields `org:undefined`, which is a perfectly valid DO name that silently
 * instantiates an empty room and swallows every event sent to it.
 */
export function liveSyncRoomNameForPrincipal(
  principal: Readonly<{ ownerUserId?: string | undefined; orgId?: string | undefined }>,
): string {
  if (principal.orgId !== undefined) return `org:${requireRoomSegment(principal.orgId, "org id")}`
  return `owner:${requireRoomSegment(principal.ownerUserId, "owner subject")}`
}

function assertLiveSyncRoomName(roomName: string): void {
  const segment = LIVE_SYNC_ROOM_NAME_PATTERN.exec(roomName)?.[1]?.trim()
  if (!segment || segment === "undefined" || segment === "null") {
    throw new Error(`live-sync room name is invalid: ${JSON.stringify(roomName)}`)
  }
}

/** POST a nudge to the room that owns `roomName`, fanning it to held clients. */
export async function nudgeLiveSyncRoom(
  namespace: LiveSyncRoomNamespace,
  roomName: string,
  event: ClaxedoEvent,
): Promise<{ delivered: number; held: number }> {
  assertLiveSyncRoomName(roomName)
  const response = await namespace
    .get(namespace.idFromName(roomName))
    .fetch(
      new Request("https://live-sync-room.internal/nudge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      }),
    )
  if (!response.ok) {
    throw new Error(`live-sync-room nudge failed: ${response.status} ${await response.text()}`.trim())
  }
  return (await response.json()) as { delivered: number; held: number }
}
