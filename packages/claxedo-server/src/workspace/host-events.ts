import type { Context } from "hono"
import { EVENT_STREAM_HEARTBEAT_MS } from "@claxedo/agent-runtime-contract"
import type { ControlPlaneServices } from "../authority/services"
import { connectLiveSyncRoom } from "../deployments/hosted-workerd/live-sync-room.cf"
import type { LiveSyncMachineSubscriber } from "../deployments/hosted-workerd/live-sync-subscriber"
import type { LiveSyncRoomNamespace } from "../platform/http/live-sync-publish"
import { admitMachineCaller, type MachineCallerBudgets } from "./machine-caller"

/**
 * `GET /api/claxedo/host/enrollments/events` (mounted by `routes/hosted/host-enrollment.ts`): the machine's doorbell, a
 * machine-signed `text/event-stream` held in its owner's live-sync room. The
 * host routes ring `host.changed` there whenever the owner changes what the
 * machine serves or holds; the machine answers each ring with a beat, which
 * stays the one path its assignments travel on. Without this stream a change
 * waits for the machine's next interval.
 */

export type HostEventsOptions = MachineCallerBudgets & {
  liveSyncRoom?: LiveSyncRoomNamespace
  heartbeatMs?: number
}

export function machineEventsHandler(services: ControlPlaneServices, options: HostEventsOptions) {
  return async (c: Context) => {
    const admitted = await admitMachineCaller(c, services, options, "host.enrollments.events", { admitHeld: true })
    if (admitted instanceof Response) return admitted
    const room = options.liveSyncRoom
    if (!room) {
      return c.json({ error: { code: "machine_events_unavailable", message: "This control plane holds no machine event stream" } }, 503)
    }
    const machine = admitted.machine
    const subscriber: LiveSyncMachineSubscriber = { machine: { hostId: machine.hostId, ownerUserId: machine.ownerUserId } }
    // A paused machine is admitted, so its owner's resume reaches it at once
    // rather than at its next beat. No reauthorization timer: the stream
    // carries nothing the machine may act on, and a revoked enrollment is
    // refused at the machine's next beat, which stops the connector and closes
    // this stream with it.
    return await connectLiveSyncRoom(
      room,
      subscriber,
      options.heartbeatMs ?? EVENT_STREAM_HEARTBEAT_MS,
      undefined,
      c.req.header("last-event-id"),
    )
  }
}
