import type { MiddlewareHandler } from "hono"
import {
  ControlPlaneAuthError,
  controlPlaneAuthContext,
  type ControlPlaneAuthAdapter,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { isLoopbackLocalRequest } from "@claxedo/server-core/platform/http/peer-address"

/** Machine-wide authority is assigned by the deployment, never by signup or workspace membership. */
export function selfHostedOperatorSubjects(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set((env.CLAXEDO_OPERATOR_SUBJECTS ?? "").split(",").map((s) => s.trim()).filter(Boolean))
}

/**
 * Whether a workspace on this box is an operator's. A signed box asks the
 * authority who owns it; an unsigned box is reached only over loopback, by the
 * one person who runs it.
 */
export async function operatorOwnsWorkspace(input: {
  signed: boolean
  workspaceId: string
  authority?: Pick<WorkspaceAuthority, "resolveWorkspaceOwner">
  subjects?: ReadonlySet<string>
}): Promise<boolean> {
  if (!input.signed) return true
  const owner = await input.authority?.resolveWorkspaceOwner?.(input.workspaceId).catch(() => undefined)
  return owner !== undefined && (input.subjects ?? selfHostedOperatorSubjects()).has(owner.userId)
}

export function selfHostedOperatorAuthorizer(env: NodeJS.ProcessEnv = process.env) {
  const subjects = selfHostedOperatorSubjects(env)
  return (identity: SignedControlPlaneAuth) => {
    if (!subjects.has(identity.user.subject)) {
      throw new ControlPlaneAuthError(403, "operator_required", "Deployment operator access is required")
    }
  }
}

export function selfHostedOperatorGuard(
  auth: ControlPlaneAuthAdapter,
  authorize = selfHostedOperatorAuthorizer(),
): MiddlewareHandler {
  return async (c, next) => {
    try {
      const identity = await controlPlaneAuthContext(c.req.raw, {
        config: auth.config,
        ...(auth.verifier ? { verifier: auth.verifier } : {}),
      })
      if (identity.mode === "unsigned-local") {
        if (!isLoopbackLocalRequest(c.req.raw)) {
          return c.json({ error: { code: "loopback_only", message: "Machine control requires a loopback peer" } }, 403)
        }
      } else {
        authorize(identity)
      }
    } catch (error) {
      if (!(error instanceof ControlPlaneAuthError)) throw error
      return c.json({ error: { code: error.code, message: error.message } }, error.status)
    }
    return next()
  }
}
