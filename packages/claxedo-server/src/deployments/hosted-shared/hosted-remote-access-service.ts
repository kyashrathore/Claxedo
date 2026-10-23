import { MINIMUM_CONNECT_CLI_VERSION, cliVersionBelowAccepted } from "@claxedo/account-contract/machine"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { HostDevice } from "@claxedo/server-core/platform/auth/host-devices"
import { connectCommands } from "../../routes/hosted/connect-scripts"
import type { RemoteAccessDevice, RemoteAccessOwnerService } from "../../routes/remote-access"
import type { HostChangedInput, MachineChangedInput } from "../../workspace/route-support"

/**
 * The connect script with no code replaces a CLI below the accepted version;
 * the service is then installed again so it restarts on the new one.
 */
function updateHint(device: HostDevice, controlPlaneOrigin: string | undefined): RemoteAccessDevice["update"] {
  if (!controlPlaneOrigin || !device.cli_version || !cliVersionBelowAccepted(device.cli_version)) return undefined
  const commands = connectCommands(controlPlaneOrigin)
  const command = /^windows\b/i.test(device.os ?? "")
    ? `${commands.windows}; claxedo connect --install-service`
    : `${commands.posix} && claxedo connect --install-service`
  return { version: MINIMUM_CONNECT_CLI_VERSION, command }
}

function remoteAccessDevice(device: HostDevice, controlPlaneOrigin: string | undefined): RemoteAccessDevice {
  const update = updateHint(device, controlPlaneOrigin)
  return {
    hostId: device.host_id,
    enrollmentId: device.enrollment_id,
    displayName: device.display_name,
    lastSeenAt: device.last_seen_at,
    state: device.state,
    workspaceIds: device.workspace_ids,
    servingWorkspaceIds: device.workspace_ids.filter((id) => device.acked_workspace_ids.includes(id)),
    ...(device.cli_version ? { cliVersion: device.cli_version } : {}),
    ...(device.os ? { os: device.os } : {}),
    ...(device.arch ? { arch: device.arch } : {}),
    ...(device.roots
      ? {
          roots: device.roots.map((root) => ({
            path: root.path,
            retires: root.retires.map((assignment) => ({ workspaceId: assignment.workspace_id, displayName: assignment.display_name, directory: assignment.directory })),
          })),
        }
      : {}),
    ...(device.blocked ? { blocked: { reason: device.blocked.reason, fix: device.blocked.fix, reportedAt: device.blocked.reported_at } } : {}),
    ...(update ? { update } : {}),
  }
}

/**
 * The owner's view of their machines on the hosted control plane: which are
 * enrolled, what they serve, when they were last seen, what they last
 * reported, renaming and revoking one. The machine side (enrolling, opening
 * the tunnel) lives on the machine itself; the control plane keeps the
 * account's picture of it.
 */
export function hostedRemoteAccessService(
  authority: WorkspaceAuthority,
  options: {
    hostChanged?: (input: HostChangedInput) => Promise<void>
    machineChanged?: (input: MachineChangedInput) => Promise<void>
    /** Where the update command fetches the connect script; absent, no update is offered. */
    controlPlaneOrigin?: string
  } = {},
): RemoteAccessOwnerService {
  return {
    async status(auth?: SignedControlPlaneAuth) {
      if (!auth) return { enrolled: false, enabled: false }
      const active = await authority.activeHostEnrollment(auth)
      return { enrolled: active.active, enabled: active.active }
    },
    async devices(auth) {
      return (await authority.listHostDevices(auth)).map((device) => remoteAccessDevice(device, options.controlPlaneOrigin))
    },
    async revoke(auth, hostId) {
      if (!authority.revokeHostEnrollment) {
        throw new ControlPlaneAuthError(503, "workspace_authority_unavailable", "This control plane does not support revoking a machine")
      }
      const result = await authority.revokeHostEnrollment(auth, { hostId })
      // Rung so the machine's next beat, the refused one, is now rather than
      // up to an interval away.
      if (result.revoked > 0) await options.hostChanged?.({ ownerUserId: auth.user.subject, hostId })
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
      await options.machineChanged?.({ ownerUserId: auth.user.subject, hostId })
      return { displayName: result.display_name }
    },
  }
}
