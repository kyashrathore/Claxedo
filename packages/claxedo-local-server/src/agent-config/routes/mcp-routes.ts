import { Hono } from "hono"
import { errorBody } from "@claxedo/server-core/platform/http/http"
import { localAgentConfigAllowed } from "../local-auth"
import type { AgentConfigRouteOptions } from "../route-options"
import { record } from "../../platform/json"
import {
  HostedMcpUrlError,
  installHostedMcpEntry,
  removeHostedMcpEntry,
} from "../hosted-mcp-install"

export function agentConfigMcpRoutes(options: AgentConfigRouteOptions = {}) {
  return new Hono()
    .post("/mcp-install", async (c) => {
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local MCP config",
      })
      if (localOnly) return localOnly
      const body = record(await c.req.json().catch(() => null))
      const controlPlaneUrl = typeof body?.controlPlaneUrl === "string" ? body.controlPlaneUrl : undefined
      if (!controlPlaneUrl) {
        return c.json(errorBody("agent_config_mcp_control_plane_required", "controlPlaneUrl is required"), 400)
      }
      try {
        return c.json(await installHostedMcpEntry({ controlPlaneUrl }))
      } catch (error) {
        if (error instanceof HostedMcpUrlError) {
          return c.json(errorBody("agent_config_mcp_control_plane_invalid", error.message), 400)
        }
        throw error
      }
    })

    .delete("/mcp-install", async (c) => {
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local MCP config",
      })
      if (localOnly) return localOnly
      return c.json(await removeHostedMcpEntry())
    })
}
