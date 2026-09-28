import { Hono } from "hono"
import { getRuntimeConfigSnapshot } from "@claxedo/server-core/agent-config/index"
import { agentConfigConnectionRoutes } from "./connection-routes"
import { agentConfigCommandRoutes } from "./command-routes"
import { agentConfigHarnessRoutes } from "./harness-routes"
import { localAgentConfigAllowed } from "../local-auth"
import { agentConfigProviderRoutes } from "./provider-routes"
import type { AgentConfigRouteOptions } from "../route-options"

export function createAgentConfigRoutes(options: AgentConfigRouteOptions = {}) {
  return new Hono()
    .route("/", agentConfigProviderRoutes(options))
    .route("/", agentConfigConnectionRoutes(options))
    .route("/", agentConfigHarnessRoutes(options))
    .route("/", agentConfigCommandRoutes(options))

    .get("/", async (c) => {
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local Agent Config",
      })
      if (localOnly) return localOnly
      // The snapshot's `auth` map is bearer authority over the operator's
      // stored credentials for the next hour, and it reaches the runtime over
      // the runtime's own management channel. This is the config surface a
      // page reads; nothing that can call it needs the placeholders.
      const { auth: _auth, ...snapshot } = await getRuntimeConfigSnapshot()
      return c.json(snapshot)
    })
}

export function AgentConfigRoutes(options: AgentConfigRouteOptions = {}) {
  return createAgentConfigRoutes(options)
}
