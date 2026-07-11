import type { RuntimeAccessTokenRole, WorkspaceConnectionInfo } from "../../utils/workspace-relay-connection"
import type { SessionRef } from "../identity/session-ref"
import { hasBacking } from "../identity/session-ref"
import {
  requiresSignedLegacyDirectory,
  workspaceIdFromRef,
} from "../identity/legacy-resolver"
import { centralTransportForServer, isLocalPersonalScope } from "@claxedo/shell/data/transport/transport"

export type RelayRole = RuntimeAccessTokenRole

export type Placement = {
  workspaceId?: string
  hostId?: string
  hosting: "central" | "workspace"
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
    hosting: "central",
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
    workspaceKind?: "local" | "cloud" | "user-hosted" | null
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
  if (input.ref?.host === "central") {
    return signedCentralPlacement({
      workspaceId: input.ref.workspaceId,
      transport: centralTransportForServer(input.serverUrl),
    })
  }
  if (input.ref && hasBacking(input.ref)) {
    return { hosting: "workspace", transport: "loopback" }
  }

  const legacyWorkspaceId = input.legacy?.workspaceId ?? workspaceIdFromRef(input.legacy?.directory)
  if (input.legacy?.workspaceKind === "cloud" || input.legacy?.workspaceKind === "user-hosted") {
    if (legacyWorkspaceId) {
      return {
        workspaceId: legacyWorkspaceId,
        hosting: "workspace",
        transport: "workspace-relay",
      }
    }
    return {
      hosting: "central",
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
    return { hosting: "central", transport: "signed-web" }
  }
  return undefined
}
