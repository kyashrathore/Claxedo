import type { ClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"
import { regionValue } from "@claxedo/server-core/platform/runtime/region/index"
import {
  clampTtlSeconds,
  HOST_TUNNEL_TOKEN_TTL_BOUNDS_SECONDS,
  RUNTIME_ACCESS_TOKEN_TTL_BOUNDS_SECONDS,
  type HostTunnelTokenSigner,
  type RuntimeAccessTokenSigner,
} from "@claxedo/server-core/platform/auth/runtime-access-token"
import type { RelayRole } from "@claxedo/workspace-relay"
import type {
  RelayProvider,
  RelayTarget,
  RelayToken,
  RelayTokenInput,
} from "@claxedo/server-core/adapters/relay-port"
import type { RelayTargetLookup } from "@claxedo/server-core/adapters/relay-port"

export type {
  RelayProvider,
  RelayTarget,
  RelayToken,
  RelayTokenInput,
} from "@claxedo/server-core/adapters/relay-port"

export type ControlPlaneRelayProviderOptions = {
  relay: {
    relayUrl?: string
    relayUrls?: Partial<Record<ClaxedoRegion, string>>
  }
  runtimeAccessTokenSigner: RuntimeAccessTokenSigner
  hostTunnelTokenSigner: HostTunnelTokenSigner
  targetLookup: RelayTargetLookup
  recordRuntimeAccessToken: (input: RelayTokenInput & RelayToken) => Promise<unknown>
  drainWorkspace?: (workspaceId: string) => Promise<void>
  telemetry?: {
    capture: (distinctId: string, event: string, properties?: Record<string, unknown>) => void
  }
}

function clampedRelayTtlSeconds(ttlMs: number, bounds: { readonly min: number; readonly max: number }) {
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) return undefined
  return clampTtlSeconds(ttlMs / 1000, bounds, bounds.min)
}

export function createControlPlaneRelayProvider(options: ControlPlaneRelayProviderOptions): RelayProvider {
  return {
    getRelayEndpoint: (_workspaceId, homeRegion) => {
      const relayUrl = regionValue(options.relay.relayUrls, homeRegion)?.trim() ?? options.relay.relayUrl?.trim()
      if (!relayUrl) throw new Error(`Workspace relay endpoint is not configured for ${homeRegion}`)
      return relayUrl
    },
    mintHostTunnelToken: async (input) => {
      const ttlSeconds = clampedRelayTtlSeconds(input.ttlMs, HOST_TUNNEL_TOKEN_TTL_BOUNDS_SECONDS)
      const token = await options.hostTunnelTokenSigner({
        subject: input.subject,
        hostId: input.hostId,
        workspaceIds: [input.workspaceId],
        ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
      })
      return {
        token: token.hostTunnelToken,
        expiresAt: token.tokenExpiresAt,
        jti: token.jti,
      }
    },
    mintRuntimeAccessToken: async (input) => {
      if (!input.orgId) throw new Error("org id required")
      const ttlSeconds = clampedRelayTtlSeconds(input.ttlMs, RUNTIME_ACCESS_TOKEN_TTL_BOUNDS_SECONDS)
      const token = await options.runtimeAccessTokenSigner({
        subject: input.subject,
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        hostId: input.hostId,
        role: input.role ?? "viewer",
        ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
      })
      const result = {
        token: token.runtimeAccessToken,
        expiresAt: token.tokenExpiresAt,
        jti: token.jti,
      }
      await options.recordRuntimeAccessToken({ ...input, ...result })
      return result
    },
    resolveTarget: async (workspaceId, hostId) => {
      const target = await options.targetLookup({ workspaceId, hostId })
      if (!target.found) return
      return {
        workspaceId,
        hostId,
        baseUrl: target.baseUrl,
        access: target.access,
        backing: target.backing,
      }
    },
    drainWorkspace: async (workspaceId) => {
      await options.drainWorkspace?.(workspaceId)
      options.telemetry?.capture("system", "relay_provider.drain_workspace", { workspaceId })
    },
  }
}
