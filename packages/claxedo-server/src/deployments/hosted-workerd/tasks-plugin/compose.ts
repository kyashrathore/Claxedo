import type { D1Database } from "@cloudflare/workers-types"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import type { HostedServerPlugin } from "@claxedo/server-core/plugins/server-plugin"
import type { TasksActor, TasksSessionBridgePort } from "@claxedo/tasks"
import { createTasksSessionBridge } from "@claxedo/tasks/host/session-bridge"
import { createHostedTasksPlugin, type HostedTasksGrants, type HostedTasksPorts } from "@claxedo/tasks/hosted"
import type { ControlPlaneServices } from "../../../authority/services"
import type { HostedSessionPorts } from "../../../plugin-backends/sessions/compose"
import { createHostedSessionHost, type HostedSessionHostInput } from "../../../plugin-backends/sessions/host"
import { signedOrError } from "../../../workspace/route-support"

export type HostedTasksPluginInput = {
  services: ControlPlaneServices
  database: D1Database
  authentication: RequestAuthenticationAdapter
  /** The deployment's session host ports, shared with the app plugins' platform so both draw on one create admission. */
  sessions: HostedSessionPorts
  /**
   * Whether a root's sandbox start projects the capability set a preset
   * names: only a build whose runtime preparation projects that set does, and
   * without it a preset naming cloud placement is refused when it is saved.
   */
  cloudSelectedCapabilities: boolean
  grants?: HostedTasksGrants
}

/** Who a Tasks request is and what this deployment can place, from its authority, request authentication and sandbox manager. */
export function hostedTasksIdentityPorts(
  input: Pick<HostedTasksPluginInput, "services" | "authentication">,
): Pick<HostedTasksPorts, "authority" | "signed" | "cloudPlacement"> {
  const { services } = input
  return {
    authority: requireAuthority(services),
    signed: (request) => signedOrError(request, { authentication: input.authentication, requireSigned: true }, services),
    // The same reading the workspace routes make before they will create a
    // cloud workspace at all: without a sandbox manager this deployment has no
    // isolated root to allocate.
    cloudPlacement: Boolean(services.sandbox.sandboxManager),
  }
}

/** Tasks' Start over this deployment's session host. */
export function hostedTasksSessionBridge(input: HostedSessionHostInput<TasksActor>): TasksSessionBridgePort {
  return createTasksSessionBridge(createHostedSessionHost(input))
}

/** The Tasks plugin over this deployment's authority, D1 rows and session host. */
export function composeHostedTasksPlugin(input: HostedTasksPluginInput): HostedServerPlugin {
  return createHostedTasksPlugin({
    ...hostedTasksIdentityPorts(input),
    bridge: (principal, auth, owner) => hostedTasksSessionBridge({ ...input.sessions, principal, auth, owner }),
    database: input.database,
    cloudSelectedCapabilities: input.cloudSelectedCapabilities,
    ...(input.grants ? { grants: input.grants } : {}),
  })
}
