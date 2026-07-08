import { claxedoBus } from "../bus"

export type ProvisionStep = "acquiring_sandbox" | "cloning" | "starting_runtime" | "waiting_health" | "ready" | "error"

export function emitProvision(workspaceId: string, step: ProvisionStep, extra?: Record<string, unknown>) {
  claxedoBus.publish({
    type: "provision",
    workspaceId,
    step,
    ts: Date.now(),
    ...extra,
  })
}
