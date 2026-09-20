/**
 * The self-hosted node's relay-resolver lookups, injected into
 * `InternalRelayResolverRoutes` and the relay provider: cloud workspaces
 * resolve through the SandboxManager lease, machine-placed ones through the
 * authority's service-side target resolver (the SQLite twin of the hosted
 * Worker's D1 lookup), which is what lets this node route to a `claxedo
 * connect` machine.
 */

import type { SandboxManager } from "@claxedo/sandbox-manager"
import type { HostTunnelTargetResolver } from "@claxedo/server-core/adapters/relay-port"
import type { ControlPlaneTelemetry } from "../../authority/services"
import { sandboxRelayTargetLookup } from "../../authority/sandbox-relay-target"
import type { LocalRelayTargetExists, RelayTargetLookup } from "../shared-routes/internal-relay"

export function localRelayTargetLookup(
  options: {
    sandboxManager?: SandboxManager
    hostTunnelResolver?: HostTunnelTargetResolver
    telemetry?: ControlPlaneTelemetry
  } = {},
): RelayTargetLookup {
  return sandboxRelayTargetLookup({
    ...(options.sandboxManager ? { sandboxManager: options.sandboxManager } : {}),
    ...(options.hostTunnelResolver ? { hostTunnelResolver: options.hostTunnelResolver } : {}),
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
  })
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
