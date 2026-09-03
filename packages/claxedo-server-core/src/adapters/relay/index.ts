import type { ClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"
import { regionValue } from "@claxedo/server-core/platform/runtime/region/index"
import {
  clampTtlSeconds,
  HOST_TUNNEL_TOKEN_TTL_BOUNDS_SECONDS,
  RUNTIME_ACCESS_TOKEN_TTL_BOUNDS_SECONDS,
  type HostTunnelTokenSigner,
  type RuntimeAccessTokenSigner,
} from "@claxedo/server-core/platform/auth/runtime-access-token"
import type {
  RelayProvider,
  RelayTarget,
  RelayToken,
  RelayTokenInput,
  HostTunnelTokenInput,
} from "@claxedo/server-core/adapters/relay-port"
import type { RelayTargetLookup } from "@claxedo/server-core/adapters/relay-port"

export type {
  HostTunnelTokenInput,
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

function requireRuntimeTokenText(value: string, label: string) {
  if (!value.trim()) throw new Error(`${label} required`)
}

function validateRuntimeTokenInput(input: RelayTokenInput) {
  requireRuntimeTokenText(input.orgId, "org id")
  requireRuntimeTokenText(input.workspaceId, "workspace id")
  requireRuntimeTokenText(input.hostId, "host id")
  requireRuntimeTokenText(input.actorId, "actor id")
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
      // Validate the complete authorization scope before calling the signer.
      // Recording still runs before the token is returned, but a malformed
      // scope must never become a signed credential even transiently.
      validateRuntimeTokenInput(input)
      const ttlSeconds = clampedRelayTtlSeconds(input.ttlMs, RUNTIME_ACCESS_TOKEN_TTL_BOUNDS_SECONDS)
      const token = await options.runtimeAccessTokenSigner({
        principalKind: input.principalKind,
        actorId: input.actorId,
        actorKind: input.actorKind,
        ...(input.actorPublicId && input.actorName
          ? {
              actorPublicId: input.actorPublicId,
              actorName: input.actorName,
              ...(input.actorAvatarUrl ? { actorAvatarUrl: input.actorAvatarUrl } : {}),
            }
          : {}),
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        hostId: input.hostId,
        role: input.role,
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
