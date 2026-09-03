import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { RemoteAccessOwnerService } from "../../routes/remote-access"

/**
 * The owner's view of their machines on the hosted control plane: which are
 * enrolled, what they serve, when they were last seen, and revoking one. The
 * machine side (enrolling, opening the tunnel) lives in the desktop app on the
 * machine itself; the control plane keeps the account's picture of it.
 */
export function hostedRemoteAccessService(authority: WorkspaceAuthority): RemoteAccessOwnerService {
  return {
    async status(auth?: SignedControlPlaneAuth) {
      if (!auth) return { enrolled: false, enabled: false, secondDeviceOpen: false }
      const active = await authority.activeHostEnrollment(auth)
      return { enrolled: active.active, enabled: active.active, secondDeviceOpen: false }
    },
    async devices(auth) {
      const [assignments, active] = await Promise.all([
        authority.listHostAssignments(auth),
        authority.activeHostEnrollment(auth),
      ])
      const devices = assignments.map((host) => ({
        hostId: host.host_id,
        displayName: host.display_name,
        lastSeenAt: host.last_seen_at,
        workspaceIds: host.workspace_ids,
      }))
      // An enrolled machine that serves nothing yet is still a device.
      if (active.active && !devices.some((device) => device.hostId === active.host_id)) {
        devices.unshift({
          hostId: active.host_id,
          displayName: active.display_name ?? active.host_id,
          lastSeenAt: active.last_seen_at,
          workspaceIds: [],
        })
      }
      return devices
    },
    async revoke(auth, hostId) {
      if (!authority.revokeHostEnrollment) {
        throw new ControlPlaneAuthError(503, "workspace_authority_unavailable", "This control plane does not support revoking a machine")
      }
      const result = await authority.revokeHostEnrollment(auth, { hostId })
      return { revoked: result.revoked > 0 }
    },
    async markSecondDeviceOpen(auth, workspaceId) {
      const result = await authority.markSecondDeviceOpen(auth, { workspaceId })
      return { recorded: result.recorded }
    },
  }
}
