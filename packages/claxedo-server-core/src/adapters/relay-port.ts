import type { ClaxedoRegion } from "../platform/runtime/region/index"
import type { RelayRole } from "@claxedo/workspace-relay"

/**
 * The Relay port, without its implementation.
 *
 * A local route producer forwards a relay provider when the composition has
 * one; it never constructs one. Naming the type from the adapter module made
 * that forwarding reach the hosted internal-relay route and, through it, the
 * Convex authority — at compile time, for a field it only passes along.
 *
 * The factory and its options stay in `@claxedo/server`, which is where the
 * hosted wiring lives.
 */
export type RelayProvider = {
  getRelayEndpoint: (workspaceId: string, homeRegion: ClaxedoRegion) => string | Promise<string>
  mintHostTunnelToken: (input: HostTunnelTokenInput) => Promise<RelayToken>
  mintRuntimeAccessToken: (input: RelayTokenInput) => Promise<RelayToken>
  resolveTarget: (workspaceId: string, hostId: string) => Promise<RelayTarget | undefined>
  drainWorkspace: (workspaceId: string) => Promise<void>
}

type RelayTokenBaseInput = {
  workspaceId: string
  hostId: string
  subject: string
  orgId?: string
  role?: RelayRole
  ttlMs: number
}

export type HostTunnelTokenInput = RelayTokenBaseInput

export type RelayTokenInput = Omit<RelayTokenBaseInput, "role"> & {
  principalKind: "user" | "service"
  actorId: string
  actorKind: "human" | "agent"
  role: RelayRole
  actorPublicId?: string
  actorName?: string
  actorAvatarUrl?: string
}

export type RelayToken = {
  token: string
  expiresAt: number
  jti: string
}

export type RelayTarget = {
  workspaceId: string
  hostId: string
  baseUrl: string
  access: "cloud" | "user-hosted"
  backing: "cloud-vm" | "local-worktree"
}

/**
 * How a composition answers "where does this workspace's runtime live".
 *
 * The Node/local server injects a workspace-store-backed lookup; the hosted
 * Worker injects a Convex-backed one. The TYPE belongs here so that naming it
 * — as the relay provider's options do — does not reach either implementation.
 */
export type RelayTargetResult =
  | {
      found: true
      baseUrl: string
      access: "cloud" | "user-hosted"
      backing: "cloud-vm" | "local-worktree"
      upstreamHeaders?: Record<string, string>
    }
  | {
      found: false
      code: "relay_resolver_workspace_not_found" | "relay_resolver_workspace_target_unavailable"
    }

export type RelayTargetLookup = (args: {
  workspaceId: string
  hostId: string
  /**
   * When provided (Cloudflare Worker), background work spawned by the lookup
   * (sandbox touch + its telemetry) should be scheduled through this so the
   * runtime does not cancel it after the response is returned.
   */
  waitUntil?: (promise: Promise<unknown>) => void
}) => Promise<RelayTargetResult>
