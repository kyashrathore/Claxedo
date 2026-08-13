import { createMiddleware } from "hono/factory"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"
import { errorBody } from "./http"

export function denyWorkspaceViewers(message: string) {
  return createMiddleware<{ Variables: RelayHostAuthContext }>(async (c, next) => {
    if (c.get("relayHostAuth")?.role === "viewer") {
      return c.json(errorBody("relay_role_denied", message), 403)
    }
    return await next()
  })
}
