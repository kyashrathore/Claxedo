import { ConvexHttpClient } from "convex/browser"
import { anyApi } from "convex/server"
import type { UserHostedTargetResolver } from "../../sandbox-relay-target"
import { controlPlaneTimeoutMs, withTimeout } from "./timeout"

// Service-authenticated resolver for the routable host of a user-hosted
// workspace. The hosted internal-relay resolver calls in with the
// control-plane service token (no end-user identity), so it queries
// `hostEnrollments.activeWorkspaceHostForRelay` (service-token authenticated)
// rather than the signed `activeWorkspaceHost` query.
//
// Same three conditions as the D1 resolver
// (`authority/adapters/d1/user-hosted-relay-target.ts`): the workspace must be
// owner-assigned to a host, inside that machine's heartbeat-acked served set,
// and the machine's enrollment lease must be live.
//
// Cloud workspaces resolve through the SandboxLease; user-hosted workspaces
// have no lease (the host dials *out* to the relay), so the relay routes by
// `hostId` over the established tunnel and `baseUrl` is empty.

const hostEnrollments = (anyApi as unknown as {
  hostEnrollments: { activeWorkspaceHostForRelay: unknown }
}).hostEnrollments

export function createUserHostedTargetResolver(input: {
  convexUrl: string
  serviceToken: string
}): UserHostedTargetResolver {
  const client = new ConvexHttpClient(input.convexUrl)
  return async (workspaceId) => {
    if (!workspaceId.trim()) return { active: false }
    const result = await withTimeout(client.query(hostEnrollments.activeWorkspaceHostForRelay as never, {
      service_token: input.serviceToken,
      workspace_id: workspaceId,
    } as never), controlPlaneTimeoutMs("read")) as
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
