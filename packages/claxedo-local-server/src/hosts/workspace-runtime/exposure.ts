import {
  embeddedWorkspaceRuntimeExposure,
  loopbackWorkspaceRuntimeExposure,
  privateNetworkDevUnsafeWorkspaceRuntimeExposure,
  relayWorkspaceRuntimeExposure,
  type WorkspaceRuntimeExposure,
  type WorkspaceRuntimeRequestGuard,
} from "@claxedo/workspace-runtime/exposure"
import type { RelayHostAuthOptions } from "@claxedo/workspace-runtime/relay"

export function createClaxedoRuntimeExposure(input:
  | { kind: "embedded"; owner?: string; guard: WorkspaceRuntimeRequestGuard }
  | { kind: "loopback" }
  | { kind: "relay"; auth: RelayHostAuthOptions }
  | { kind: "dev-unsafe-private-network"; reason: string }
): WorkspaceRuntimeExposure {
  if (input.kind === "embedded") return embeddedWorkspaceRuntimeExposure({ owner: input.owner ?? "claxedo-server", guard: input.guard })
  if (input.kind === "relay") return relayWorkspaceRuntimeExposure(input.auth)
  if (input.kind === "dev-unsafe-private-network") return privateNetworkDevUnsafeWorkspaceRuntimeExposure(input.reason)
  return loopbackWorkspaceRuntimeExposure()
}
