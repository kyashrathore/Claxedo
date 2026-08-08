import type {
  MachineRemoteAccessDevice,
  MachineRemoteAccessPort,
  MachineRemoteAccessStatus,
} from "./machine-remote-access-port"

/**
 * The port over `/api/claxedo/remote-access/*`.
 *
 * This is the self-hosted Node product's implementation, and the browser's.
 * `deployments/self-hosted-node/app.ts` mounts `RemoteAccessRoutes` at that
 * prefix, so the server on the other end of `request` publishes the machine it
 * is itself running on.
 *
 * Moved here from `features/onboarding/remote-access-api.ts`. It was shared app
 * code performing one product's transport, which is exactly why the desktop
 * kept calling routes its sidecar had stopped serving. A feature may not own a
 * platform mechanism; it names the operation and this layer decides the call.
 *
 * The funnel events that used to be emitted from inside `enable` and
 * `markSecondDeviceOpen` are NOT here. Onboarding's funnel is caller-specific
 * policy and belongs with the caller; the desktop implementation of the same
 * port would otherwise have had to reproduce it to stay equivalent.
 *
 * Snake_case in, camelCase out: the wire shape is the server's vocabulary and
 * stops at this boundary. Every field is checked rather than cast, so a server
 * that changed shape fails here, naming the field, instead of three components
 * later.
 */
export type RemoteAccessRequest = (path: string, init?: RequestInit) => Promise<Response>

type RemoteAccessStatusBody = {
  device_login_configured?: unknown
  relay_configured?: unknown
  hosted_signed_in?: unknown
  enabled?: unknown
  enrolled?: unknown
  second_device_open?: unknown
}

export function httpMachineRemoteAccess(input: { request?: RemoteAccessRequest } = {}): MachineRemoteAccessPort {
  const request = input.request ?? fetch
  const json = async (path: string, init?: RequestInit) => {
    const response = await request(path, init)
    const body = await response.json() as Record<string, unknown>
    if (!response.ok) {
      const error = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : undefined
      throw new Error(typeof error?.message === "string" ? error.message : `Remote access request failed (${response.status})`)
    }
    return body
  }

  return {
    async status(): Promise<MachineRemoteAccessStatus> {
      const body = await json("/api/claxedo/remote-access") as RemoteAccessStatusBody
      return {
        deviceLoginConfigured: body.device_login_configured === true,
        relayConfigured: body.relay_configured === true,
        hostedSignedIn: body.hosted_signed_in === true,
        enabled: body.enabled === true,
        enrolled: body.enrolled === true,
        secondDeviceOpen: body.second_device_open === true,
      }
    },
    async enable(options) {
      const body = await json("/api/claxedo/remote-access/enable", {
        method: "POST",
        body: JSON.stringify({ display_name: options.displayName, start_at_login: options.startAtLogin }),
      })
      // Checked and discarded. The port returns nothing, but a 200 carrying no
      // host id is a server that did not enroll anything, and resolving on it
      // would report success for a machine that was never published.
      requiredString(body.host_id, "host_id")
      requiredNumber(body.connection_count, "connection_count")
    },
    async devices(): Promise<readonly MachineRemoteAccessDevice[]> {
      const body = await json("/api/claxedo/remote-access/devices")
      if (!Array.isArray(body.devices)) return []
      return body.devices.flatMap((value) => {
        if (!value || typeof value !== "object") return []
        const device = value as Record<string, unknown>
        if (typeof device.host_id !== "string" || typeof device.display_name !== "string" || typeof device.last_seen_at !== "number") return []
        return [{
          hostId: device.host_id,
          displayName: device.display_name,
          lastSeenAt: device.last_seen_at,
          workspaceIds: stringArray(device.workspace_ids),
        }]
      })
    },
    async revoke(hostId: string) {
      const body = await json(`/api/claxedo/remote-access/devices/${encodeURIComponent(hostId)}`, { method: "DELETE" })
      return { revoked: body.revoked === true }
    },
    async markSecondDeviceOpen({ workspaceId, sourceClientId, currentClientId }) {
      const body = await json(`/api/claxedo/remote-access/workspaces/${encodeURIComponent(workspaceId)}/second-device-open`, {
        method: "POST",
        body: JSON.stringify({ source_client_id: sourceClientId, current_client_id: currentClientId }),
      })
      return { recorded: body.recorded === true }
    },
  }
}

function stringArray(input: unknown) {
  return Array.isArray(input) ? input.filter((value): value is string => typeof value === "string") : []
}

function requiredString(input: unknown, field: string) {
  if (typeof input === "string") return input
  throw new Error(`Remote access response is missing ${field}`)
}

function requiredNumber(input: unknown, field: string) {
  if (typeof input === "number") return input
  throw new Error(`Remote access response is missing ${field}`)
}
