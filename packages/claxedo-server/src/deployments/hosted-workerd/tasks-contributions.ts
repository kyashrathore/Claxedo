import type { ControlPlaneRouteContribution } from "@claxedo/server-core/platform/http/route-contribution"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import {
  createHostedTasksComposition,
  hostedTasksRuntimeClient,
  type HostedTasksCompositionInput,
} from "../../tasks/hosted-composition"
import { tasksGrantRenewalContribution, type TasksGrantRenewalInput } from "../../tasks/grant-renewal"
import {
  createHostedTasksSessionBridge,
  type HostedTasksSessionBridgeInput,
} from "../../tasks/session-bridge"

/**
 * The hosted Tasks routes a Worker entry mounts, with the session bridge each
 * request's principal is handed to, and the renewal door a running root's
 * grant comes back through.
 *
 * The composition and the bridge are paired here rather than in the entry
 * because the bridge is per-principal and the composition is per-Worker: an
 * entry that built one without the other would serve Tasks routes that cannot
 * start a session. Renewal is paired with them because it verifies against the
 * same register the composition refuses revoked grants from; a deployment that
 * mints no grants — no signing key — mounts no renewal either.
 */
export function hostedTasksRouteContributions(
  input: Omit<HostedTasksCompositionInput, "bridge" | "cloudSelectedCapabilities"> & {
    selectedCapabilities?: NonNullable<HostedTasksSessionBridgeInput["selectedCapabilities"]>
    /**
     * The environment the workspace routes launch every cloud root with. A
     * task's root is launched by the bridge, so it is handed the same one.
     */
    rootEnvironment?: NonNullable<HostedTasksSessionBridgeInput["capability"]>
    releaseRuntime?: HostedTasksSessionBridgeInput["releaseRuntime"]
    sandboxEgress: HostedTasksSessionBridgeInput["sandboxEgress"]
    renewal?: Pick<TasksGrantRenewalInput, "tasksGroupEnabled" | "grant">
  },
): readonly ControlPlaneRouteContribution[] {
  const composition = createHostedTasksComposition({
    ...input,
    cloudSelectedCapabilities: Boolean(input.selectedCapabilities),
    bridge: (principal, auth) =>
      createHostedTasksSessionBridge({
        services: input.services,
        runtimeClient: hostedTasksRuntimeClient(input.services),
        principal,
        auth,
        ...(input.selectedCapabilities ? { selectedCapabilities: input.selectedCapabilities } : {}),
        ...(input.rootEnvironment ? { capability: input.rootEnvironment } : {}),
        ...(input.releaseRuntime ? { releaseRuntime: input.releaseRuntime } : {}),
        sandboxEgress: input.sandboxEgress,
      }),
  })
  const owners = requireAuthority(input.services).resolveWorkspaceOwner?.bind(requireAuthority(input.services))
  if (!input.renewal || !input.signingEnv || !owners) return composition.routeContributions
  return [
    ...composition.routeContributions,
    tasksGrantRenewalContribution({
      signingEnv: input.signingEnv,
      ...(input.passes ? { passes: input.passes } : {}),
      workspaceOwner: owners,
      ...input.renewal,
    }),
  ]
}
