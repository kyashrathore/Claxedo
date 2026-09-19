import type { WorkspaceConnectionInfo } from "@/platform/runtime/agent/workspace-relay-connection"
import type { RelayRole } from "@/platform/auth/role"
export type { RelayRole } from "@/platform/auth/role"
import type { SessionRef } from "@/platform/identity/session-ref"
import { hasBacking } from "@/platform/identity/session-ref"
import {
  requiresSignedLegacyDirectory,
  workspaceIdFromRef,
} from "@/platform/identity/legacy-resolver"
import { isLocalPersonalScope } from "@/platform/runtime/transport"
import type { WorkspaceHostKind } from "@/platform/runtime/placement-wire"

export type Placement = {
  workspaceId?: string
  hostId?: string
  hosting: "control-plane" | "workspace"
  transport: "loopback" | "signed-web" | "workspace-relay" | "direct-runtime"
  role?: RelayRole
}

export function signedCentralPlacement(input: {
  workspaceId?: string
  role?: RelayRole
  transport?: "loopback" | "signed-web"
}): Placement {
  return {
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    hosting: "control-plane",
    transport: input.transport ?? "signed-web",
    ...(input.role ? { role: input.role } : {}),
  }
}

export function placementFromWorkspaceConnection(connection: WorkspaceConnectionInfo): Placement {
  return {
    workspaceId: connection.workspaceId,
    hosting: "workspace",
    transport: connection.directRuntimeUrl ? "direct-runtime" : "workspace-relay",
    role: connection.role,
  }
}

export function placementFor(input: {
  ref?: SessionRef
  hasSignedAccess: boolean
  serverUrl?: string
  legacy?: {
    directory?: string
    workspaceId?: string
    hostKind?: WorkspaceHostKind | null
  }
}): Placement | undefined {
  if (!input.hasSignedAccess) return undefined
  if (input.ref?.toolSandbox?.kind === "workspace") {
    return {
      workspaceId: input.ref.toolSandbox.workspaceId,
      hostId: input.ref.toolSandbox.hostId,
      hosting: "workspace",
      transport: "workspace-relay",
    }
  }

  if (input.ref && hasBacking(input.ref)) {
    return { hosting: "workspace", transport: "loopback" }
  }

  const legacyWorkspaceId = input.legacy?.workspaceId ?? workspaceIdFromRef(input.legacy?.directory)
  if (input.legacy?.hostKind === "provisioner" || input.legacy?.hostKind === "machine") {
    if (legacyWorkspaceId) {
      return {
        workspaceId: legacyWorkspaceId,
        hosting: "workspace",
        transport: "workspace-relay",
      }
    }
    return {
      hosting: "control-plane",
      transport: "signed-web",
    }
  }
  if (legacyWorkspaceId) {
    return {
      workspaceId: legacyWorkspaceId,
      hosting: "workspace",
      transport: "workspace-relay",
    }
  }
  if (isLocalPersonalScope({ serverUrl: input.serverUrl, directory: input.legacy?.directory })) {
    return { hosting: "workspace", transport: "loopback" }
  }
  if (requiresSignedLegacyDirectory(input.legacy?.directory)) {
    return { hosting: "control-plane", transport: "signed-web" }
  }
  return undefined
}
