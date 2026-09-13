import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneRouteContribution } from "@claxedo/server-core/platform/http/route-contribution"
import {
  createHostedTasksComposition,
  hostedTasksRuntimeClient,
  type HostedTasksCompositionInput,
} from "../../tasks/hosted-composition"
import {
  createHostedTasksSessionBridge,
  type HostedTasksSessionBridgeInput,
} from "../../tasks/session-bridge"
import { createTasksRootCapability } from "../../tasks/root-capability"

/**
 * The hosted Tasks routes a Worker entry mounts, with the session bridge each
 * request's principal is handed to.
 *
 * The composition and the bridge are paired here rather than in the entry
 * because the bridge is per-principal and the composition is per-Worker: an
 * entry that built one without the other would serve Tasks routes that cannot
 * start a session.
 */
export function hostedTasksRouteContributions(
  input: Omit<HostedTasksCompositionInput, "bridge" | "cloudSelectedCapabilities"> & {
    selectedCapabilities?: NonNullable<HostedTasksSessionBridgeInput["selectedCapabilities"]>
    /** What the root's project consented to; the grant is minted only when Tasks is among it. */
    builtinToolGroups: (auth: SignedControlPlaneAuth, projectId: string) => Promise<readonly string[]>
  },
): readonly ControlPlaneRouteContribution[] {
  // One signing key decides both halves: a deployment that can mint a root's
  // Tasks grant is exactly the one whose routes will verify it.
  const capability = input.signingEnv
    ? createTasksRootCapability({
        signingEnv: input.signingEnv,
        enabledToolGroups: (root, auth) => input.builtinToolGroups(auth, root.projectId),
      })
    : undefined
  return createHostedTasksComposition({
    ...input,
    cloudSelectedCapabilities: Boolean(input.selectedCapabilities),
    bridge: (principal, auth) =>
      createHostedTasksSessionBridge({
        services: input.services,
        runtimeClient: hostedTasksRuntimeClient(input.services),
        principal,
        auth,
        ...(input.selectedCapabilities ? { selectedCapabilities: input.selectedCapabilities } : {}),
        ...(capability ? { capability } : {}),
      }),
  }).routeContributions
}
