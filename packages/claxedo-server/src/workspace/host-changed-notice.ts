import { liveSyncRoomNameForPrincipal, nudgeLiveSyncRoom, type LiveSyncRoomNamespace } from "../platform/http/live-sync-publish"
import type { HostChangedInput } from "./route-support"

/**
 * Rings one of the owner's machines through the owner's live-sync room, where
 * the machine holds its doorbell stream (`routes/hosted/host-events.ts`). A
 * ring that fails is logged, not surfaced: the change is already recorded and
 * the machine's heartbeat interval still delivers it.
 */
export function liveSyncHostChanged(room: LiveSyncRoomNamespace, now: () => number = Date.now) {
  return async (input: HostChangedInput) => {
    try {
      await nudgeLiveSyncRoom(
        room,
        liveSyncRoomNameForPrincipal({ ownerUserId: input.ownerUserId }),
        { type: "host.changed", hostId: input.hostId, ownerUserId: input.ownerUserId, ts: now() },
      )
    } catch (error) {
      console.warn("[claxedo-server] host.changed ring failed", { hostId: input.hostId, error: String(error) })
    }
  }
}
