import { controlBus } from "@claxedo/server-core/platform/runtime/lib/bus"

export type ProvisionStep = "acquiring_sandbox" | "cloning" | "starting_runtime" | "waiting_health" | "ready" | "error"

export function emitProvision(
  workspace: { id: string; org_id?: string },
  step: ProvisionStep,
  extra?: Record<string, unknown>,
) {
  controlBus.publish({
    type: "provision",
    workspaceId: workspace.id,
    ...(workspace.org_id ? { orgId: workspace.org_id } : {}),
    step,
    ts: Date.now(),
    ...extra,
  })
}
