import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { liveSyncRoomNameForPrincipal, nudgeLiveSyncRoom, type LiveSyncRoomNamespace } from "../platform/http/live-sync-publish"
import type { HostChangedInput, MachineChangedInput } from "./route-support"

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

/**
 * Tells a person's app that one of their machines or pairings moved. A
 * machine is the person's, not one organization's, and the app holds the room
 * of the organization it is signed in to, so the notice goes to the room of
 * each organization they belong to. A notice that fails is logged, not
 * surfaced: the change is already recorded and the app's next read shows it.
 */
export function liveSyncMachineChanged(
  room: LiveSyncRoomNamespace,
  authority: Pick<WorkspaceAuthority, "machineOwnerOrgIds">,
  now: () => number = Date.now,
) {
  return async (input: MachineChangedInput) => {
    if (!authority.machineOwnerOrgIds) return
    try {
      const event = {
        type: "machine.changed", ownerUserId: input.ownerUserId, ts: now(),
        ...(input.hostId ? { hostId: input.hostId } : {}),
        ...(input.pairingId ? { pairingId: input.pairingId } : {}),
      } as const
      for (const orgId of await authority.machineOwnerOrgIds(input.ownerUserId)) {
        await nudgeLiveSyncRoom(room, liveSyncRoomNameForPrincipal({ orgId }), event)
      }
    } catch (error) {
      console.warn("[claxedo-server] machine.changed notice failed", { hostId: input.hostId, pairingId: input.pairingId, error: String(error) })
    }
  }
}

/**
 * The hosted plane's machine notices: the ring a machine hears, the notice its
 * owner's app hears, and the owner-side change that sends both, since a
 * machine's owner sees what the change did to it in the app.
 */
export function hostedMachineNotices(room: LiveSyncRoomNamespace, authority: () => Pick<WorkspaceAuthority, "machineOwnerOrgIds">) {
  const ringMachine = liveSyncHostChanged(room)
  const machineChanged = liveSyncMachineChanged(room, { machineOwnerOrgIds: (ownerUserId) => authority().machineOwnerOrgIds?.(ownerUserId) ?? Promise.resolve([]) })
  const hostChanged = async (input: HostChangedInput) => {
    await ringMachine(input)
    await machineChanged(input)
  }
  return { ringMachine, machineChanged, hostChanged }
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
