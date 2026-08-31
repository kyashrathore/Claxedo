import type { Context } from "hono"
import {
  sessionAccessContext,
  sessionAccessDenied,
  type SessionAccessOperation,
  type SessionAccessPolicy,
} from "../session-access-policy"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"

export type HostCapabilityAccessOptions = {
  sessionAccessPolicy?: SessionAccessPolicy
}

/**
 * Authorize a workspace-host capability from the identity established by the
 * relay-host middleware. Local and nonce-bound in-process callers have no
 * relay identity and retain the existing local behavior. A verified remote
 * caller, however, must always have the host-selected policy available; an
 * incomplete remote composition fails closed instead of silently becoming a
 * workspace-wide capability.
 */
export async function authorizeHostCapability(
  c: Context<{ Variables: RelayHostAuthContext }>,
  options: HostCapabilityAccessOptions,
  operation: SessionAccessOperation,
  verifiedContext: ReturnType<typeof sessionAccessContext> = sessionAccessContext(c),
  sessionId?: string,
) {
  const context = verifiedContext
  if (!context.authority && !options.sessionAccessPolicy) return
  if (!options.sessionAccessPolicy) {
    return sessionAccessDenied({
      allowed: false,
      status: 503,
      code: "session_authority_required",
      message: "Workspace host capability authority is unavailable",
    })
  }
  if (context.authority && (operation === "agent_setup_read" || operation === "agent_setup_write")) {
    if (!options.sessionAccessPolicy.authorizeHost) {
      return sessionAccessDenied({
        allowed: false,
        status: 503,
        code: "host_authority_required",
        message: "Current workspace host authority is unavailable",
      })
    }
    const decision = await options.sessionAccessPolicy.authorizeHost({
      ...context,
      operation,
      minimumRole: operation === "agent_setup_write" ? "admin" : "viewer",
      method: c.req.method,
      path: c.req.path,
    })
    if (!decision.allowed) return sessionAccessDenied(decision)
    return
  }
  const decision = await options.sessionAccessPolicy.authorize({
    ...context,
    operation,
    ...(sessionId ? { sessionId } : {}),
    method: c.req.method,
    path: c.req.path,
  })
  if (!decision.allowed) return sessionAccessDenied(decision)
}
