import type { Hono } from "hono"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import type { HostedControlPlane } from "../../authority/hosted-services"
import { ownerDirectDelivery, PI_DIRECT_PROVIDERS } from "../../credentials/direct-rows"
import type { MachineProviderConfig } from "../../credentials/machine-provider-config"
import { liveSyncRoomNameForPrincipal, nudgeLiveSyncRoom, type LiveSyncRoomNamespace } from "../../platform/http/live-sync-publish"
import { ConnectScriptRoutes } from "../../routes/hosted/connect-scripts"
import { HostEnrollmentRoutes, HostInvitationRoutes } from "../../routes/hosted/host-enrollment"
import { HostPairingRoutes } from "../../routes/hosted/host-pairing"
import { HostSessionRowsRoutes } from "../../routes/hosted/host-session-rows"
import type { HostedWorkspaceRouteOptions } from "../../routes/hosted/workspace"
import { RemoteAccessOwnerRoutes } from "../../routes/remote-access"
import { createSessionHostRows } from "../../session/session-host-rows"
import type { SessionRowsPasses } from "../../session/session-rows-pass"
import { signedOrError, type HostChangedInput } from "../../workspace/route-support"
import { hostedRemoteAccessService } from "./hosted-remote-access-service"

/**
 * The routes a machine is connected through: its owner's enrollment and the
 * machine's own beat, the session rows it publishes, the owner's invitations
 * and pairings, the connect scripts a pairing's command fetches, and remote
 * access.
 */
export function mountHostedHostRoutes(app: Hono, input: {
  plane: HostedControlPlane
  workspaceOptions: HostedWorkspaceRouteOptions
  authentication: RequestAuthenticationAdapter
  liveSyncRoom: LiveSyncRoomNamespace
  sessionRowsPasses?: SessionRowsPasses
  machineProviderConfig?: MachineProviderConfig
  hostChanged: (host: HostChangedInput) => Promise<void>
}) {
  const { plane, workspaceOptions, authentication, liveSyncRoom } = input
  const { services } = plane
  const orgCredentials = plane.orgCredentials
  app.route("/api/claxedo/host/enrollments", HostEnrollmentRoutes(services, {
    ...workspaceOptions,
    liveSyncRoom,
    ...(orgCredentials ? {
      ownerPiDirectRows: async (auth) => (await ownerDirectDelivery(orgCredentials(await requireAuthority(services).resolveOrgId(auth)), auth.user.subject, { providers: PI_DIRECT_PROVIDERS })).direct,
    } : {}),
    ...(input.machineProviderConfig ? { machineProviderConfig: input.machineProviderConfig } : {}),
  }))
  app.route("/api/claxedo/host/session-rows", HostSessionRowsRoutes(services, {
    notify: (orgId, notices) => nudgeLiveSyncRoom(liveSyncRoom, liveSyncRoomNameForPrincipal({ orgId }), notices),
    ...(input.sessionRowsPasses ? { sessionRowsPasses: input.sessionRowsPasses } : {}),
    ...(services.sessionHosts && services.authority?.resolveWorkspaceOwner
      ? {
          sessionHostRows: createSessionHostRows({
            env: plane.env,
            sessionHosts: services.sessionHosts,
            resolveWorkspaceOwner: services.authority.resolveWorkspaceOwner.bind(services.authority),
          }),
        }
      : {}),
  }))
  const controlPlaneOrigin = authentication.descriptor.native.cli.controlPlaneOrigin
  app.route("/api/claxedo/host/invitations", HostInvitationRoutes(services, { ...workspaceOptions, controlPlaneOrigin }))
  app.route("/api/claxedo/host/pairings", HostPairingRoutes(services, { ...workspaceOptions, controlPlaneOrigin }))
  app.route("/api/claxedo", ConnectScriptRoutes(controlPlaneOrigin))
  app.route("/api/claxedo/remote-access", RemoteAccessOwnerRoutes({
    deviceLoginConfigured: true,
    relayConfigured: !!services.relay.provider,
    authenticate: async (request) => {
      const result = await signedOrError(request, { authentication, requireSigned: true }, services)
      if ("error" in result) return Response.json(result.error, { status: result.status })
      if (!result.auth) return Response.json({ error: { code: "UNAUTHORIZED", message: "Signed auth is required" } }, { status: 401 })
      return result.auth
    },
    service: hostedRemoteAccessService(requireAuthority(services), {
      hostChanged: input.hostChanged,
      ...(workspaceOptions.machineChanged ? { machineChanged: workspaceOptions.machineChanged } : {}),
      controlPlaneOrigin,
    }),
  }))
}
