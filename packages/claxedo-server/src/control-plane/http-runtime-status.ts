import { z } from "zod"
import { resolveWorkspace, updateWorkspace } from "../workspace/store/store"
import type { ControlPlaneServices } from "./services"
import { ControlPlaneProtocolError, runtimeSnapshotInput } from "./http-protocol"

export async function registerControlRuntime(
  services: ControlPlaneServices,
  input: z.infer<typeof runtimeSnapshotInput>,
) {
  const ws = await workspaceStrict(input.workspaceId)
  await patchLease(services, input, "register")
  await updateWorkspace(input.workspaceId, {
    status: input.status || (input.ok ? "ready" : ws.status),
  })
}

export async function heartbeatControlRuntime(
  services: ControlPlaneServices,
  input: z.infer<typeof runtimeSnapshotInput>,
) {
  await workspaceStrict(input.workspaceId)
  await patchLease(services, input, "heartbeat")
}

async function workspaceStrict(workspaceId: string) {
  const hit = await resolveWorkspace({ workspaceId })
  if (hit) return hit
  throw new ControlPlaneProtocolError(404, "workspace_not_found", `workspace ${workspaceId} not found`)
}

async function patchLease(
  services: ControlPlaneServices,
  input: z.infer<typeof runtimeSnapshotInput>,
  operation: "register" | "heartbeat",
) {
  const now = Date.now()
  const active = input.activeProcessCount > 0 || input.ptyCount > 0
  const sandboxManager = services.sandbox.sandboxManager
  if (sandboxManager) {
    const result = await sandboxManager[operation](input.workspaceId, {
      ok: input.ok,
      status: input.status,
      url: input.url ?? undefined,
      sandboxId: input.sandboxId,
      epoch: input.epoch ?? undefined,
      active,
      now,
    })
    if (!result.ok) {
      throw new ControlPlaneProtocolError(
        409,
        result.reason,
        `sandbox manager rejected ${operation} for ${input.workspaceId}: ${result.reason}`,
      )
    }
    return
  }
  throw new ControlPlaneProtocolError(
    503,
    "sandbox_manager_unavailable",
    `sandbox manager is not configured for ${operation}`,
  )
}
