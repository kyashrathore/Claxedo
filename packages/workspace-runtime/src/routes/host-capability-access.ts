import type { Context } from "hono"
import {
  sessionAccessContext,
  sessionAccessDenied,
  sessionAccessRequiresWrite,
  type SessionAccessOperation,
  type SessionAccessPolicy,
} from "@claxedo/session-core"
import type { RelayHostAuthContext } from "@claxedo/session-core/relay-host"

export type HostCapabilityAccessOptions = {
  sessionAccessPolicy?: SessionAccessPolicy
}

const HOST_OPERATIONS = new Set<SessionAccessOperation>(["agent_setup_read", "agent_setup_write", "checkpoint_write"])

const MACHINE_TREE_OPERATIONS = new Set<SessionAccessOperation>(["worktree_read", "worktree_write"])

/**
 * Whether a relayed caller is acting on the machine itself rather than on one
 * session. A tree no session claims is the machine's, so reading or writing it
 * is a host question; the same operation on a session's own worktree is that
 * session's.
 */
function isHostOperation(operation: SessionAccessOperation, sessionId: string | undefined) {
  return HOST_OPERATIONS.has(operation) || (sessionId === undefined && MACHINE_TREE_OPERATIONS.has(operation))
}

/**
 * Authorize a workspace-host capability from the identity established by the
 * relay-host middleware. Local and nonce-bound in-process callers have no
 * relay identity and get the policy's local decision. A verified remote
 * caller, however, must always have the host-selected policy available; an
 * incomplete remote composition fails closed instead of silently becoming a
 * workspace-wide capability.
 *
 * A relayed host operation is decided by the current host authority on every
 * request: a relay host token keeps verifying after the token it was minted
 * from is revoked, and only that authority knows.
 */
export async function authorizeHostCapability(
  c: Context<{ Variables: RelayHostAuthContext }>,
  options: HostCapabilityAccessOptions,
  operation: SessionAccessOperation,
  verifiedContext: ReturnType<typeof sessionAccessContext> = sessionAccessContext(c),
  sessionId?: string,
) {
  const context = verifiedContext
  if (!context.authority && !options.sessionAccessPolicy) return undefined
  if (!options.sessionAccessPolicy) {
    return sessionAccessDenied({
      allowed: false,
      status: 503,
      code: "session_authority_required",
      message: "Workspace host capability authority is unavailable",
    })
  }
  if (context.authority && isHostOperation(operation, sessionId)) {
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
      hostAccess: sessionAccessRequiresWrite({ operation }) ? "admin" : "read",
      method: c.req.method,
      path: c.req.path,
    })
    if (!decision.allowed) return sessionAccessDenied(decision)
    return undefined
  }
  const decision = await options.sessionAccessPolicy.authorize({
    ...context,
    operation,
    ...(sessionId ? { sessionId } : {}),
    method: c.req.method,
    path: c.req.path,
  })
  if (!decision.allowed) return sessionAccessDenied(decision)
  return undefined
}
