import type { OnboardingFunnelEvent } from "./funnel"

export type RemoteAccessRequest = (path: string, init?: RequestInit) => Promise<Response>

type RemoteAccessStatusBody = {
  device_login_configured?: unknown
  relay_configured?: unknown
  hosted_signed_in?: unknown
  enabled?: unknown
  second_device_open?: unknown
}

export function createRemoteAccessClient(input: {
  request?: RemoteAccessRequest
  emit?: (event: Extract<OnboardingFunnelEvent, { name: "remote_access_enabled" | "second_device_open" }>) => void
} = {}) {
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
    async status() {
      const body = await json("/api/claxedo/remote-access") as RemoteAccessStatusBody
      return {
        deviceLoginConfigured: body.device_login_configured === true,
        relayConfigured: body.relay_configured === true,
        hostedSignedIn: body.hosted_signed_in === true,
        enabled: body.enabled === true,
        secondDeviceOpen: body.second_device_open === true,
      }
    },
    async enable(options: { displayName: string; startAtLogin: boolean }) {
      const body = await json("/api/claxedo/remote-access/enable", {
        method: "POST",
        body: JSON.stringify({ display_name: options.displayName, start_at_login: options.startAtLogin }),
      })
      const result = {
        hostId: requiredString(body.host_id, "host_id"),
        workspaceIds: stringArray(body.workspace_ids),
        connectionCount: requiredNumber(body.connection_count, "connection_count"),
      }
      input.emit?.({ name: "remote_access_enabled" })
      return result
    },
    async devices() {
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
    async markSecondDeviceOpen(workspaceId: string, sourceClientId: string, currentClientId: string) {
      const body = await json(`/api/claxedo/remote-access/workspaces/${encodeURIComponent(workspaceId)}/second-device-open`, {
        method: "POST",
        body: JSON.stringify({ source_client_id: sourceClientId, current_client_id: currentClientId }),
      })
      const recorded = body.recorded === true
      if (recorded) input.emit?.({ name: "second_device_open" })
      return { recorded }
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
