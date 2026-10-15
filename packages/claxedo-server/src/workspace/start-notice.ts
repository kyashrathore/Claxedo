import type { ProvisionEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import { liveSyncRoomNameForPrincipal, nudgeLiveSyncRoom, type LiveSyncRoomNamespace } from "../platform/http/live-sync-publish"
import type { SandboxStartDrive } from "./sandbox-start"

/** A workspace's machine start told to its owner's live-sync room; a workspace with no active owner has nobody to tell. */
export function liveSyncStartNotice(input: {
  room: LiveSyncRoomNamespace
  owner: (workspaceId: string) => Promise<{ userId: string; orgId: string } | undefined>
  now?: () => number
}): NonNullable<SandboxStartDrive["announce"]> {
  const now = input.now ?? Date.now
  return async (workspaceId, step) => {
    const owner = await input.owner(workspaceId)
    if (!owner) return
    const event: ProvisionEvent = { type: "provision", workspaceId, ownerUserId: owner.userId, orgId: owner.orgId, step, ts: now() }
    await nudgeLiveSyncRoom(input.room, liveSyncRoomNameForPrincipal({ ownerUserId: owner.userId, orgId: owner.orgId }), event)
  }
}
