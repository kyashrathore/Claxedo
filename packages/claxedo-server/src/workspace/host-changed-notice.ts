import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { liveSyncRoomNameForPrincipal, nudgeLiveSyncRoom, type LiveSyncRoomNamespace } from "../platform/http/live-sync-publish"
import type { HostChangedInput } from "./route-support"

/**
 * Rings one of the owner's machines through the owner's live-sync room, where
 * the machine holds its doorbell stream (`workspace/host-events.ts`). A
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

export type RingMachinesServing = (workspaceIds: readonly string[]) => Promise<void>

/**
 * Rings each machine serving one of these workspaces after a change that can
 * narrow someone's access to it, so the machine forgets the authority answers
 * it reuses at once instead of when they lapse, a minute at most. A lookup
 * that fails is logged, not surfaced: the change is already written, and the
 * lapse still bounds it.
 */
export function ringMachinesServing(
  authority: Pick<WorkspaceAuthority, "machinesServingWorkspaces">,
  hostChanged: (input: HostChangedInput) => Promise<void>,
): RingMachinesServing {
  return async (workspaceIds) => {
    if (!authority.machinesServingWorkspaces || workspaceIds.length === 0) return
    let machines: HostChangedInput[]
    try {
      machines = await authority.machinesServingWorkspaces(workspaceIds)
    } catch (error) {
      console.warn("[claxedo-server] machines to ring could not be read", { workspaces: workspaceIds.length, error: String(error) })
      return
    }
    const rung = new Set<string>()
    for (const machine of machines) {
      const key = `${machine.ownerUserId}\0${machine.hostId}`
      if (rung.has(key)) continue
      rung.add(key)
      await hostChanged(machine)
    }
  }
}
