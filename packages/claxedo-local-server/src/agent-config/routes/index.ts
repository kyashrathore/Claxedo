import { Hono } from "hono"
import { getRuntimeConfigSnapshot } from "@claxedo/server-core/agent-config/index"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { agentConfigConnectionRoutes } from "./connection-routes"
import { agentConfigCommandRoutes } from "./command-routes"
import { agentConfigHarnessRoutes } from "./harness-routes"
import { sandboxJson } from "../sandbox-json"
import { localAgentConfigAllowed } from "../local-auth"
import { agentConfigMcpRoutes } from "./mcp-routes"
import { agentConfigProviderRoutes } from "./provider-routes"
import type { AgentConfigRouteOptions } from "../route-options"
import { sandboxFetchOptions } from "./harness-routes"

export function createAgentConfigRoutes(options: AgentConfigRouteOptions = {}) {
  return new Hono()
    .route("/", agentConfigProviderRoutes(options))
    .route("/", agentConfigConnectionRoutes(options))
    .route("/", agentConfigHarnessRoutes(options))
    .route("/", agentConfigMcpRoutes(options))
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

    .get("/agents", async (c) => {
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local agent profile config",
      })
      if (localOnly) return localOnly
      const directory = c.req.query("directory") || c.req.header("x-claxedo-directory")
      const workspaceId = c.req.query("workspaceId") || c.req.query("workspace") || c.req.header("x-workspace-id")
      const ws = await resolveWorkspace({
        workspaceId,
        directory,
      }).catch(() => undefined)
      if (!ws) return c.json([])
      const url = new URL("/agent", "http://sandbox-manager.local")
      url.searchParams.set("directory", ws.kind === "cloud" ? ws.remote_directory || "/workspace" : ws.directory)
      const agents = await sandboxJson(
        ws,
        `${url.pathname}${url.search}`,
        undefined,
        await sandboxFetchOptions(c, options, ws.id),
      ).catch(() => [])
      return c.json(Array.isArray(agents) ? agents : [])
    })
}

export function AgentConfigRoutes(options: AgentConfigRouteOptions = {}) {
  return createAgentConfigRoutes(options)
}
