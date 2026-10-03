import type { ControlPlaneEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import { liveSyncRoomNameForPrincipal, nudgeLiveSyncRoom, type LiveSyncRoomNamespace } from "./live-sync-publish"

export function createSessionNoticeSink(namespace: LiveSyncRoomNamespace) {
  return async (event: ControlPlaneEvent) => {
    if (!("ownerUserId" in event) || typeof event.ownerUserId !== "string" || !event.ownerUserId) {
      throw new Error("A private session notice requires its recipient subject")
    }
    const room = liveSyncRoomNameForPrincipal({ ownerUserId: event.ownerUserId })
    return nudgeLiveSyncRoom(namespace, room, event)
  }
}
