/**
 * Local (Node/desktop) relay-resolver lookups backed by SandboxManager.
 * These are injected into `InternalRelayResolverRoutes` from the local Node
 * server (`server.ts`). The hosted Worker injects hosted-state lookups instead.
 */

import type { SandboxManager } from "@claxedo/sandbox-manager"
import type { ControlPlaneTelemetry } from "../authority/services"
import { sandboxRelayTargetLookup } from "../authority/sandbox-relay-target"
import type { LocalRelayTargetExists, RelayTargetLookup } from "../deployments/shared-routes/internal-relay"

export function localRelayTargetLookup(
  options: {
    sandboxManager?: SandboxManager
    telemetry?: ControlPlaneTelemetry
  } = {},
): RelayTargetLookup {
  const sandboxTargetLookup = sandboxRelayTargetLookup({
    ...(options.sandboxManager ? { sandboxManager: options.sandboxManager } : {}),
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
  })
  return async (args) => {
    if (options.sandboxManager) return sandboxTargetLookup(args)
    return { found: false as const, code: "relay_resolver_workspace_target_unavailable" as const }
  }
}

export function localRelayTargetExists(
  options: {
    sandboxManager?: SandboxManager
  } = {},
): LocalRelayTargetExists {
  return async ({ workspaceId, hostId }) => {
    if (options.sandboxManager) {
      const target = await options.sandboxManager.target(workspaceId).catch(() => undefined)
      return target?.status === "ready" && target.hostId === hostId
    }
    return false
  }
}
