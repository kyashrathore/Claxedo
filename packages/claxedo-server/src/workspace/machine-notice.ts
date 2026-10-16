import type { ProvisionEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import { liveSyncRoomNameForPrincipal, nudgeLiveSyncRoom, type LiveSyncRoomNamespace } from "../platform/http/live-sync-publish"

/** Tells a workspace owner's open clients what its machine just did, whoever asked for it: a start began or settled, or the machine went asleep. */
export type MachineNotice = (workspaceId: string, step: ProvisionEvent["step"]) => Promise<void>

/** A workspace's machine notice told to its owner's live-sync room; a workspace with no active owner has nobody to tell. */
export function liveSyncMachineNotice(input: {
  room: LiveSyncRoomNamespace
  owner: (workspaceId: string) => Promise<{ userId: string; orgId: string } | undefined>
  now?: () => number
}): MachineNotice {
  const now = input.now ?? Date.now
  return async (workspaceId, step) => {
    const owner = await input.owner(workspaceId)
    if (!owner) return
    const event: ProvisionEvent = { type: "provision", workspaceId, ownerUserId: owner.userId, orgId: owner.orgId, step, ts: now() }
    await nudgeLiveSyncRoom(input.room, liveSyncRoomNameForPrincipal({ ownerUserId: owner.userId, orgId: owner.orgId }), event)
  }
}
