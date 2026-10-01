import { controlBus } from "@claxedo/server-core/platform/runtime/lib/bus"
import { needWorkspaceSupervisorOptions } from "../workspace/supervisor/options"

export type ProvisionStep = "acquiring_sandbox" | "cloning" | "starting_runtime" | "waiting_health" | "ready" | "error"

/**
 * Rings a provision step for its workspace's owner. Callers await it before
 * moving to their next step: the owner lookup is asynchronous, and steps
 * published out of order would walk a settled workspace back to a spinner.
 */
export async function emitProvision(
  workspace: { id: string; org_id?: string },
  step: ProvisionStep,
  extra?: { message?: string },
) {
  const ownerUserId = await workspaceOwner(workspace.id)
  controlBus.publish({
    type: "provision",
    workspaceId: workspace.id,
    ...(workspace.org_id ? { orgId: workspace.org_id } : {}),
    ...(ownerUserId ? { ownerUserId } : {}),
    step,
    ts: Date.now(),
    ...extra,
  })
}

/**
 * `sandboxOwner` throws for a workspace no owner answers for; its error step
 * must still ring, for the unsigned operator.
 */
async function workspaceOwner(workspaceId: string) {
  try {
    return await needWorkspaceSupervisorOptions().sandboxOwner(workspaceId)
  } catch {
    return undefined
  }
}
