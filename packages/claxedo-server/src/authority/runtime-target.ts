import type { WorkspaceRecord } from "@claxedo/server-core/platform/auth/authority"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { ControlPlaneAuthContext } from "@claxedo/server-core/platform/auth/auth"
import { defaultHomeRegion, normalizeClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"
import type { ControlPlaneServices } from "./services"

export class WorkspaceRuntimeTargetError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

function text(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

export async function resolveWorkspaceRuntimeTarget(
  services: ControlPlaneServices,
  auth: ControlPlaneAuthContext | undefined,
  input: { workspaceId: string; workspace?: WorkspaceRecord },
) {
  const { workspaceId, workspace } = input
  if (workspace?.backing === "local-worktree" && workspace.access === "user-hosted") {
    if (auth?.mode !== "signed") {
      throw new WorkspaceRuntimeTargetError(
        409,
        "workspace_runtime_unavailable",
        "Workspace has no available runtime target",
      )
    }
    const activeLink = await requireAuthority(services).activeWorkspaceHost(auth, { workspaceId })
    if (!activeLink.active) {
      throw new WorkspaceRuntimeTargetError(
        409,
        "user_hosted_workspace_unavailable",
        "User-hosted sandbox is unavailable",
      )
    }
    return {
      hostId: activeLink.host_id,
      homeRegion: normalizeClaxedoRegion(
        text(workspace.home_region) ?? text(workspace.homeRegion),
        services.defaultHomeRegion ?? defaultHomeRegion(),
      ),
    }
  }
  const needsExplicitSignedPlacement = auth?.mode === "signed"
  const hasExplicitPlacement = workspace?.backing !== undefined || workspace?.access !== undefined
  if (
    (needsExplicitSignedPlacement || hasExplicitPlacement)
    && (workspace?.backing !== "cloud-vm" || workspace.access !== "cloud")
  ) {
    throw new WorkspaceRuntimeTargetError(
      409,
      "workspace_runtime_unavailable",
      "Workspace has no available runtime target",
    )
  }
  const hostManager = services.sandbox.sandboxManager
  if (!hostManager) {
    throw new WorkspaceRuntimeTargetError(503, "sandbox_unavailable", "Sandbox manager is not configured")
  }
  const target = await hostManager.target(workspaceId).catch(() => undefined)
  if (target?.status !== "ready") {
    throw new WorkspaceRuntimeTargetError(409, "cloud_runtime_unavailable", "Cloud runtime is unavailable")
  }
  return {
    hostId: target.hostId,
    homeRegion: normalizeClaxedoRegion(
      target.homeRegion,
      services.defaultHomeRegion ?? defaultHomeRegion(),
    ),
  }
}
