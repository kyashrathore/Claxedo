import type { Hono } from "hono"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { ControlPlaneEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import type { ControlPlaneServices } from "../../authority/services"
import { signedOrError } from "../../workspace/route-support"
import { createSessionReaderRoutes } from "../../session/routes/session-reader"
import { createSessionAttentionRoutes } from "../../session/routes/session-attention"
import { createHostedSessionCleanupRoutes } from "../../session/routes/session-cleanup"
import type { SessionCleanupCapabilityInput } from "../../session/cleanup-capability"

export function mountHostedSessionStateRoutes(app: Hono, options: {
  services: ControlPlaneServices
  authentication: RequestAuthenticationAdapter
  notice(event: ControlPlaneEvent): Promise<unknown>
  cleanupCapability?: SessionCleanupCapabilityInput
}) {
  const authenticate = async (request: Request) => {
    const result = await signedOrError(request, { authentication: options.authentication, requireSigned: true }, options.services)
    if ("error" in result) return Response.json(result.error, { status: result.status })
    return result.auth ?? Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 })
  }
  const authority = requireAuthority(options.services)
  app.route("/api/control", createSessionReaderRoutes({ authority, authenticate, notice: options.notice?.bind(options) }))
  app.route("/api/control", createSessionAttentionRoutes({ authority, authenticate }))
  app.route("/", createHostedSessionCleanupRoutes({ services: options.services, authenticate, capability: options.cleanupCapability }))
}
