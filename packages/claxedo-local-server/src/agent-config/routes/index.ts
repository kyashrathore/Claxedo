import { Hono } from "hono"
import { getEffectiveConfig } from "@claxedo/server-core/agent-config/index"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { agentConfigAcpConnectionRoutes } from "./acp-connection-routes"
import { agentConfigCommandRoutes } from "./command-routes"
import { agentConfigExtensionRoutes } from "./extension-routes"
import { agentConfigHarnessRoutes } from "./harness-routes"
import { sandboxJson } from "../harness"
import { localAgentConfigAllowed } from "../local-auth"
import { agentConfigMcpRoutes } from "./mcp-routes"
import type { AgentConfigRouteOptions } from "../extension-support"
import { sandboxFetchOptions } from "./harness-routes"

export function createAgentConfigRoutes(options: AgentConfigRouteOptions = {}) {
  return new Hono()
    .route("/", agentConfigAcpConnectionRoutes(options))
    .route("/", agentConfigHarnessRoutes(options))
    .route("/", agentConfigMcpRoutes(options))
    .route("/", agentConfigCommandRoutes(options))
    .route("/", agentConfigExtensionRoutes(options))

    .get("/", async (c) => {
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local Agent Config",
      })
      if (localOnly) return localOnly
      return c.json(await getEffectiveConfig())
    })

    .get("/agents", async (c) => {
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local agent profile config",
      })
      if (localOnly) return localOnly
      const directory = c.req.query("directory") || c.req.header("x-opencode-directory")
      const workspaceId = c.req.query("workspaceId") || c.req.query("workspace") || c.req.header("x-workspace-id")
      const ws = await resolveWorkspace({
        workspaceId,
        directory,
        create: !!directory,
      }).catch(() => undefined)
      if (!ws) return c.json([])
      const url = new URL("/agent", "http://sandbox-manager.local")
      url.searchParams.set("directory", ws.kind === "cloud" ? ws.remote_directory || "/workspace" : ws.directory)
      const agents = await sandboxJson<unknown[]>(
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
