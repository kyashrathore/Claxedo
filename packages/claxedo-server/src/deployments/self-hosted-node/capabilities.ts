import { workGraphRuntimeRouteContributions } from "@claxedo/workgraph/runtime-adapter"
import type { WorkspaceRuntimeRouteContribution } from "@claxedo/workspace-runtime/route-contribution"
import type { WorkGraphRunOperationBroker } from "@claxedo/workgraph/runtime-adapter"

/**
 * The hosted capabilities the SELF-HOSTED single binary contributes to its
 * embedded Workspace Runtime.
 *
 * `deployments/self-hosted-node/app.ts` currently serves two products. The desktop
 * sidecar must lose WorkGraph and Documents; the self-hosted single binary
 * ships them and always has. Making the create-app seam take a capability
 * contribution is what lets one composition satisfy both without a runtime
 * flag: desktop passes nothing, self-host passes this.
 *
 * This is a live owner, not a compatibility wrapper. Unit 7 moves it to
 * `deployments/self-hosted-node/capabilities.ts` alongside the rest of the
 * self-hosted composition and deletes the old root; nothing here is scheduled
 * for removal.
 *
 * Documents is deliberately absent. Its self-hosted backing is composed as an
 * HTTP route family on the app (`localDocumentsBackend`), not as a Workspace
 * Runtime route contribution, so it has no representation in this list. Unit 7
 * moves that composition; splitting it across two mechanisms now would create
 * the second registry this seam exists to avoid.
 */
export type SelfHostedCapabilities = {
  /** Route groups mounted into every embedded Workspace Runtime instance. */
  runtimeRouteContributions: readonly WorkspaceRuntimeRouteContribution[]
}

export function selfHostedCapabilities(input: {
  /**
   * Executes a bound WorkGraph Run command against the local run context.
   *
   * Required rather than optional: a self-hosted deployment that mounted the
   * Run tool routes without a broker would advertise the tools to every session
   * and then fail each call at execution time, which reads to the user as a
   * broken product rather than an unconfigured one.
   */
  workGraphRunBroker: WorkGraphRunOperationBroker
}): SelfHostedCapabilities {
  return {
    runtimeRouteContributions: workGraphRuntimeRouteContributions({
      run: { broker: input.workGraphRunBroker },
    }),
  }
}

/** The desktop-local composition: no hosted capability, and none reachable. */
export function noSelfHostedCapabilities(): SelfHostedCapabilities {
  return { runtimeRouteContributions: [] }
}
