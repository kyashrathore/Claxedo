import { createMiddleware } from "hono/factory"
import type { RelayHostAuthContext } from "@claxedo/session-core/relay-host"
import { CONTROL_PLANE_RUNTIME_ACTOR } from "@claxedo/server-core/platform/auth/runtime-actor"

function fromControlPlane(auth: RelayHostAuthContext["relayHostAuth"]) {
  return !!auth && "principal_kind" in auth
    && auth.principal_kind === CONTROL_PLANE_RUNTIME_ACTOR.principalKind && auth.actor_id === CONTROL_PLANE_RUNTIME_ACTOR.actorId
}

/**
 * Admits only the control plane's service actor to a route contribution. The
 * relay host auth middleware the runtime mounts ahead of every contribution is
 * what sets `relayHostAuth`.
 */
export function controlPlaneOnly(message: string) {
  return createMiddleware<{ Variables: RelayHostAuthContext }>(async (c, next) => {
    if (!fromControlPlane(c.get("relayHostAuth"))) return c.json({ error: { code: "forbidden", message } }, 403)
    return await next()
  })
}
