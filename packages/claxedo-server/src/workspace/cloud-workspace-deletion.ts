import type { Context } from "hono"
import { routeParam } from "@claxedo/helpers/route-param"
import { ControlPlaneAuthError, controlPlaneAuthErrorBody } from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import { isClaxedoError } from "@claxedo/server-core/platform/errors/base"
import type { SandboxManager } from "@claxedo/sandbox-manager"
import type { ControlPlaneServices } from "../authority/services"
import type { ConnectionRateLimiter } from "../platform/auth/rate-limit"
import { contentfulStatus } from "../platform/http/status"
import { apiError, missingBearerBody, signedOrError, type WorkspaceRouteOptions } from "./route-support"
import { controlPlaneRateLimitError } from "./runtime-token-guards"

/**
 * `DELETE /api/workspace/:id` for a cloud workspace. The sandbox goes first,
 * then what its runtime was issued, then the row: until the row is deleted
 * every step can be asked again, and a deleted row means its sandbox is gone,
 * so a repeat is answered as done.
 */
export function cloudWorkspaceDeletion(
  services: ControlPlaneServices | undefined,
  options: WorkspaceRouteOptions,
  controlPlaneRateLimiter: ConnectionRateLimiter,
) {
  const authOptions = { ...options, requireSigned: true as const }
  return async (c: Context) => {
    const workspaceId = routeParam(c, "id")
    const authResult = await signedOrError(c.req.raw, authOptions, services)
    if ("error" in authResult) return c.json(authResult.error, authResult.status)
    const auth = authResult.auth
    if (!auth) return c.json(missingBearerBody(), 401)
    try {
      const rateLimit = await controlPlaneRateLimitError(services, controlPlaneRateLimiter, auth, {
        key: `workspace.delete:${workspaceId}`,
        action: "workspace.delete.denied",
        workspaceId,
      })
      if (rateLimit) return c.json(rateLimit.body, rateLimit.status)
      const authority = requireAuthority(services)
      const opened = await authority.openWorkspace(auth, { workspaceId }).catch((error: unknown) => {
        if (error instanceof ControlPlaneAuthError && error.status === 403) return undefined
        throw error
      })
      // The authority answers a workspace its caller already deleted as done and refuses anyone else's.
      if (!opened) return c.json(await authority.deleteWorkspace(auth, { workspaceId }))
      if (opened.workspace?.backing !== "cloud-vm") {
        return c.json({ error: apiError("workspace_not_cloud", "A machine's workspace is withdrawn by unassigning its host") }, 409)
      }
      const sandboxManager = services?.sandbox.sandboxManager
      if (!sandboxManager) {
        return c.json({ error: apiError("sandbox_driver_unavailable", "No cloud sandbox driver is configured on this control plane") }, 503)
      }
      const refused = await destroySandbox(sandboxManager, workspaceId)
      if (refused) return c.json({ error: apiError("workspace_sandbox_destroy_failed", "The workspace's sandbox could not be destroyed; delete it again", { reason: refused }) }, 502)
      await options.releaseRuntime?.({ workspaceId })
      const deleted = await authority.deleteWorkspace(auth, { workspaceId })
      await authority.auditAllow(auth, { action: "workspace.deleted", workspaceId, metadata: {} })
      return c.json(deleted)
    } catch (err) {
      if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
      if (isClaxedoError(err)) return c.json({ error: apiError(err.code, err.message) }, contentfulStatus(err.status))
      throw err
    }
  }
}

/**
 * Why the sandbox may still be running; nothing once it is gone. A lease that
 * never named a provider resource is released rather than destroyed: a
 * remnant of an attempt still in flight is then unowned, which the sweep
 * collects.
 */
async function destroySandbox(sandboxManager: SandboxManager, workspaceId: string): Promise<string | undefined> {
  const destroyed = await sandboxManager.destroy(workspaceId).catch((error: unknown) => ({
    ok: false as const,
    reason: error instanceof Error ? error.message : String(error),
  }))
  if (destroyed.ok || destroyed.reason === "runtime_lease_missing") return undefined
  if (destroyed.reason !== "runtime_lease_resource_missing") return destroyed.reason
  await sandboxManager.release(workspaceId)
  return undefined
}
