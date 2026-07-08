import { ConvexHttpClient } from "convex/browser"
import { anyApi } from "convex/server"
import type { UserHostedTargetResolver } from "../../sandbox-relay-target"

// Service-authenticated resolver for the current user-hosted host of a
// workspace. The hosted internal-relay resolver calls in with the control-plane
// service token (no end-user identity), so it queries `localHostLinks.activeForRelay`
// (service-token authenticated) rather than the signed `active` query.
//
// Cloud workspaces resolve through the SandboxLease; user-hosted
// workspaces have no lease (the host dials *out* to the relay), so the relay
// routes by `hostId` over the established tunnel and `baseUrl` is empty.

const localHostLinks = (anyApi as unknown as {
  localHostLinks: { activeForRelay: unknown }
}).localHostLinks

export function createUserHostedTargetResolver(input: {
  convexUrl: string
  serviceToken: string
}): UserHostedTargetResolver {
  const client = new ConvexHttpClient(input.convexUrl)
  return async (workspaceId) => {
    const result = await client.query(localHostLinks.activeForRelay as never, {
      service_token: input.serviceToken,
      workspace_id: workspaceId,
    } as never) as
      | { active: true; host_id: string; backing?: "local-worktree" | "cloud-vm" }
      | { active: false }
    if (!result.active) return { active: false }
    return {
      active: true,
      hostId: result.host_id,
      backing: result.backing ?? "local-worktree",
    }
  }
}
