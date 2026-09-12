import type { ControlPlaneRouteContribution } from "@claxedo/server-core/platform/http/route-contribution"
import {
  createHostedTasksComposition,
  hostedTasksRuntimeClient,
  type HostedTasksCompositionInput,
} from "../../tasks/hosted-composition"
import { createHostedTasksSessionBridge } from "../../tasks/session-bridge"

/**
 * The only edge from a Worker entry into Tasks.
 *
 * The entry's gate is a `process.env.CLAXEDO_BUILD_TASKS` comparison that
 * Wrangler's esbuild folds to a literal, and esbuild can only drop what
 * nothing else references: a second import of the composition or the bridge
 * from any module the Worker reaches puts the kit back into the deployed
 * artifact with the gate still present and reading correctly.
 */
export function hostedTasksRouteContributions(
  input: Omit<HostedTasksCompositionInput, "bridge">,
): readonly ControlPlaneRouteContribution[] {
  return createHostedTasksComposition({
    ...input,
    bridge: (principal) =>
      createHostedTasksSessionBridge({
        services: input.services,
        runtimeClient: hostedTasksRuntimeClient(input.services),
        principal,
      }),
  }).routeContributions
}
