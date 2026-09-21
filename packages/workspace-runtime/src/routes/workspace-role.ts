import { createMiddleware } from "hono/factory"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"
import { errorBody } from "./http"

export type WorkspaceRoleRefusal = { allowed: false; status: 403; code: "relay_role_denied"; message: string }

/**
 * The rule itself, apart from the middleware, because a surface a router
 * cannot cover — the in-process terminal attach — has to state the same one.
 */
export function workspaceViewerRefusal(
  role: NonNullable<RelayHostAuthContext["relayHostAuth"]>["role"] | undefined,
  message: string,
): WorkspaceRoleRefusal | undefined {
  return role === "viewer" ? { allowed: false, status: 403, code: "relay_role_denied", message } : undefined
}

export function denyWorkspaceViewers(message: string) {
  return createMiddleware<{ Variables: RelayHostAuthContext }>(async (c, next) => {
    const refusal = workspaceViewerRefusal(c.get("relayHostAuth")?.role, message)
    if (refusal) return c.json(errorBody(refusal.code, refusal.message), refusal.status)
    return await next()
  })
}
