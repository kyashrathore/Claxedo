import { claxedoBus } from "@claxedo/server-core/platform/runtime/lib/bus"

export type ProvisionStep = "acquiring_sandbox" | "cloning" | "starting_runtime" | "waiting_health" | "ready" | "error"

// Takes the workspace record (not just the id) so the event carries the
// owning org — `routes/events.ts` scopes signed-mode delivery on `orgId`.
export function emitProvision(
  workspace: { id: string; org_id?: string },
  step: ProvisionStep,
  extra?: Record<string, unknown>,
) {
  claxedoBus.publish({
    type: "provision",
    workspaceId: workspace.id,
    ...(workspace.org_id ? { orgId: workspace.org_id } : {}),
    step,
    ts: Date.now(),
    ...extra,
  })
}
