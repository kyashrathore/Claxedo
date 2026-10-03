import { bearerToken, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import { resolveRuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import type { ControlPlaneServices } from "../authority/services"
import type { SessionCleanupIdentity } from "./cleanup-runtime-client"
import { isDesktopSessionCleanupScope, isMachineSessionCleanupScope, isSessionCleanupCapability, resolveSessionCleanupOwner, SessionCleanupConfigurationError, verifySessionCleanupCapability, type SessionCleanupCapabilityInput } from "./cleanup-capability"

type CleanupAuthentication = {
  services: ControlPlaneServices
  authenticate(request: Request): Promise<SignedControlPlaneAuth | Response>
  capability?: SessionCleanupCapabilityInput
}

/** The identity is stable; delegated authority must still be live for each command. */
export async function authorizeSessionCleanup(input: CleanupAuthentication, request: Request): Promise<{
  identity: SessionCleanupIdentity
  revalidate(): Promise<void>
} | Response> {
  const token = bearerToken(request.headers.get("authorization"))
  if (token && isSessionCleanupCapability(token)) {
    const capability = input.capability
    if (!capability) return Response.json({ error: { code: "session_cleanup_grant_invalid" } }, { status: 401 })
    const validate = async () => {
      let scope
      try {
        scope = await verifySessionCleanupCapability(token, capability.signingEnv, {
          ...(capability.passes ? { revoked: capability.passes.revoked } : {}),
          ...(capability.now ? { now: capability.now } : {}),
        })
      } catch (cause) {
        throw new ClaxedoError({ status: cause instanceof SessionCleanupConfigurationError ? 503 : 401, code: cause instanceof SessionCleanupConfigurationError ? cause.code : "session_cleanup_grant_invalid", message: "Session cleanup capability is invalid" })
      }
      if (!scope.sessionId && !isMachineSessionCleanupScope(scope) && !isDesktopSessionCleanupScope(scope)) {
        throw new ClaxedoError({ status: 403, code: "session_cleanup_origin_required", message: "Session cleanup requires its originating session" })
      }
      if (!(await resolveSessionCleanupOwner(capability, scope))) {
        throw new ClaxedoError({ status: 403, code: "session_cleanup_grant_withdrawn", message: "Session cleanup authority has been withdrawn" })
      }
      return scope
    }
    try {
      const scope = await validate()
      return { identity: { userId: scope.userId, actorId: scope.actorId, orgId: scope.orgId }, revalidate: async () => { await validate() } }
    } catch (error) {
      if (!(error instanceof ClaxedoError)) throw error
      return Response.json({ error: { code: error.code } }, { status: error.status })
    }
  }
  const auth = await input.authenticate(request)
  if (auth instanceof Response) return auth
  const authority = requireAuthority(input.services)
  const actor = await resolveRuntimeActor(authority, auth)
  if (actor.actorKind !== "human" || !actor.userId) return Response.json({ error: { code: "session_cleanup_access_denied" } }, { status: 403 })
  // Signed requests recheck canonical control rights at target admission and workspace dispatch.
  return { identity: { userId: actor.userId, actorId: actor.actorId, orgId: await authority.resolveOrgId(auth), auth }, revalidate: async () => {} }
}
