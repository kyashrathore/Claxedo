import type { ControlPlaneRouteContribution } from "@claxedo/server-core/platform/http/route-contribution"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import {
  createHostedTasksComposition,
  hostedTasksRuntimeClient,
  type HostedTasksCompositionInput,
} from "../../tasks/hosted-composition"
import { createD1TasksHostReads } from "../../tasks/d1-host-reads"
import { tasksGrantRenewalContribution, type TasksGrantRenewalInput } from "../../tasks/grant-renewal"
import {
  createHostedTasksSessionBridge,
  type HostedTasksSessionBridgeInput,
} from "../../tasks/session-bridge"
import {
  createCloudCreateAdmission,
  type CloudCreateAdmissionPolicy,
} from "../../workspace/cloud-create-admission"

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
    /**
     * The workspace's sandbox start, which prepares a root with its own
     * capability set. Only a build whose runtime preparation projects that set
     * names it; without it a preset naming cloud placement is refused when it
     * is saved.
     */
    sandboxStart?: HostedTasksSessionBridgeInput["sandboxStart"]
    sandboxUsage?: HostedTasksSessionBridgeInput["sandboxUsage"]
    /**
     * The deployment's half of the create admission a task's cloud root is
     * subject to — the same gates `POST /api/workspace/create` applies, keyed
     * on the person the root is created as. It is built once here, so its
     * create budget is one bucket per isolate rather than one per request.
     */
    cloudCreateAdmission?: CloudCreateAdmissionPolicy
    renewal?: Pick<TasksGrantRenewalInput, "tasksGroupEnabled" | "grant" | "ownerGrant">
  },
): readonly ControlPlaneRouteContribution[] {
  const createAdmission = createCloudCreateAdmission({
    services: input.services,
    ...input.cloudCreateAdmission,
  })
  const reads = createD1TasksHostReads(input.database)
  const composition = createHostedTasksComposition({
    ...input,
    cloudSelectedCapabilities: Boolean(input.sandboxStart),
    bridge: (principal, auth, owner) =>
      createHostedTasksSessionBridge({
        services: input.services,
        runtimeClient: hostedTasksRuntimeClient(input.services),
        reads,
        principal,
        auth,
        owner,
        ...(input.sandboxStart ? { sandboxStart: input.sandboxStart } : {}),
        ...(input.sandboxUsage ? { sandboxUsage: input.sandboxUsage } : {}),
        cloudCreateAdmission: createAdmission,
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
