import type { SandboxManager, SandboxTarget } from "@claxedo/sandbox-manager"
import type { RelayTargetLookup } from "../routes/internal-relay"
import type { ControlPlaneTelemetry } from "./services"

/**
 * Neutral resolver contract for a workspace's current user-hosted host. The
 * concrete resolver is a storage adapter (Claxedo ships one under
 * `adapters/*`); this control-plane module only depends on the shape.
 */
export type UserHostedTargetResult =
  | { active: true; hostId: string; backing: "local-worktree" | "cloud-vm" }
  | { active: false }

export type UserHostedTargetResolver = (workspaceId: string) => Promise<UserHostedTargetResult>

function clean(value: string | undefined) {
  const v = value?.trim()
  return v ? v : undefined
}

/**
 * The single SandboxManager-backed relay target lookup, consumed by hosted
 * and local control-plane composition. Resolving a target also touches the
 * lease (keep-alive) in the background; on Workers the caller passes
 * `waitUntil` so the touch survives the response.
 */
export function sandboxRelayTargetLookup(input: {
  sandboxManager?: SandboxManager
  telemetry?: ControlPlaneTelemetry
  userHostedResolver?: UserHostedTargetResolver
}): RelayTargetLookup {
  const capture = (properties: Record<string, unknown>) => {
    try {
      input.telemetry?.capture("system", "sandbox.touch", properties)
    } catch {
      // Touch telemetry is operational evidence; it must never break routing.
    }
  }
  const touch = (workspaceId: string, waitUntil?: (promise: Promise<unknown>) => void) => {
    const sandboxManager = input.sandboxManager
    if (!sandboxManager?.touch) return
    const work = sandboxManager
      .touch(workspaceId)
      .then((result) => {
        capture({ workspaceId, touched: result.touched, status: result.status })
      })
      .catch(() => {
        capture({ workspaceId, touched: false, status: "failed" })
      })
    if (waitUntil) waitUntil(work)
    else void work
  }
  const resolveUserHosted = async (args: { workspaceId: string; hostId: string }) => {
    if (!input.userHostedResolver) return undefined
    const link = await input.userHostedResolver(args.workspaceId)
    if (!link.active || link.hostId !== args.hostId) return undefined
    // The host dials *out* to the relay, so there is no baseUrl. The relay
    // routes by hostId over the established tunnel.
    return {
      found: true as const,
      baseUrl: "",
      access: "user-hosted" as const,
      backing: link.backing,
    }
  }
  const upstreamHeaders = (target: SandboxTarget) => {
    const daytonaPreviewToken = clean(target.labels?.["daytona.previewToken"])
    if (!daytonaPreviewToken) return undefined
    return { "x-daytona-preview-token": daytonaPreviewToken }
  }
  return async (args) => {
    // Cloud workspaces resolve through the SandboxLease.
    if (input.sandboxManager) {
      const target = await input.sandboxManager.target(args.workspaceId)
      if (target.status === "ready" && target.hostId === args.hostId) {
        const headers = upstreamHeaders(target)
        touch(args.workspaceId, args.waitUntil)
        return {
          found: true,
          baseUrl: target.url,
          access: "cloud",
          backing: "cloud-vm",
          ...(headers ? { upstreamHeaders: headers } : {}),
        }
      }
    }
    // User-hosted workspaces have no sandbox lease; resolve the registered
    // host link.
    const userHosted = await resolveUserHosted(args)
    if (userHosted) return userHosted
    return {
      found: false,
      code: "relay_resolver_workspace_target_unavailable",
    }
  }
}
