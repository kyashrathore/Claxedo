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
      if (!auth) return { enrolled: false, enabled: false }
      const active = await authority.activeHostEnrollment(auth)
      return { enrolled: active.active, enabled: active.active }
    },
    async devices(auth) {
      return (await authority.listHostDevices(auth)).map((device) => ({
        hostId: device.host_id,
        enrollmentId: device.enrollment_id,
        displayName: device.display_name,
        lastSeenAt: device.last_seen_at,
        state: device.state,
        workspaceIds: device.workspace_ids,
      }))
    },
    async revoke(auth, hostId) {
      if (!authority.revokeHostEnrollment) {
        throw new ControlPlaneAuthError(503, "workspace_authority_unavailable", "This control plane does not support revoking a machine")
      }
      const result = await authority.revokeHostEnrollment(auth, { hostId })
      return { revoked: result.revoked > 0 }
    },
    async rename(auth, { hostId, displayName }) {
      if (!authority.hostEnrollmentByHost || !authority.renameHostEnrollment) {
        throw new ControlPlaneAuthError(503, "workspace_authority_unavailable", "This control plane does not support renaming a machine")
      }
      const enrollment = await authority.hostEnrollmentByHost(auth, { hostId })
      if (!enrollment) return undefined
      const result = await authority.renameHostEnrollment(auth, {
        enrollmentId: enrollment.enrollment_id,
        displayName,
      })
      return { displayName: result.display_name }
    },
  }
}
