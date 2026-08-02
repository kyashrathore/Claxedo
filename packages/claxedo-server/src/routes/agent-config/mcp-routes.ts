import { Hono } from "hono"
import { loadUserConfig, saveUserConfig } from "../../agent-config"
import { fanOutConfig } from "../../config-fanout"
import { ensureHostForUrl, removeAutoHostsForSource } from "../../network/policy"
import { errorBody } from "../http"
import { localAgentConfigAllowed } from "./local-auth"
import type { AgentConfigRouteOptions } from "./extension-support"

export function agentConfigMcpRoutes(options: AgentConfigRouteOptions = {}) {
  return new Hono()
    .get("/mcp", async (c) => {
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local MCP config",
      })
      if (localOnly) return localOnly
      const { mcp } = await loadUserConfig()
      return c.json(mcp)
    })

    .post("/mcp/:name", async (c) => {
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local MCP config",
      })
      if (localOnly) return localOnly
      const name = c.req.param("name")
      if (!name || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
        return c.json(
          errorBody("agent_config_mcp_name_invalid", "Invalid server name (alphanumeric, dash, underscore only)"),
          400,
        )
      }

      const body = await c.req.json().catch(() => null)
      if (!body || typeof body !== "object") {
        return c.json(errorBody("agent_config_invalid_body", "Invalid JSON body"), 400)
      }

      const { type, command, args, env, url, headers, disabled } = body as Record<string, unknown>

      if (type !== "stdio" && type !== "remote") {
        return c.json(errorBody("agent_config_mcp_type_invalid", "type must be 'stdio' or 'remote'"), 400)
      }
      if (type === "stdio" && typeof command !== "string") {
        return c.json(errorBody("agent_config_mcp_command_required", "command is required for stdio servers"), 400)
      }
      if (type === "remote" && typeof url !== "string") {
        return c.json(errorBody("agent_config_mcp_url_required", "url is required for remote servers"), 400)
      }

      const config = await loadUserConfig()
      config.mcp[name] = {
        type: type as "stdio" | "remote",
        ...(type === "stdio"
          ? {
              command: command as string,
              args: Array.isArray(args) ? (args as string[]) : [],
              env: (env as Record<string, string>) ?? {},
            }
          : {
              url: url as string,
              headers: (headers as Record<string, string>) ?? {},
            }),
        ...(typeof disabled === "boolean" ? { disabled } : {}),
      }
      await saveUserConfig(config)
      fanOutConfig().catch(() => {})

      if (type === "remote" && typeof url === "string") {
        ensureHostForUrl(url as string, `mcp:${name}`)
      }

      return c.json({ ok: true, name })
    })

    .delete("/mcp/:name", async (c) => {
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local MCP config",
      })
      if (localOnly) return localOnly
      const name = c.req.param("name")
      const config = await loadUserConfig()
      if (!(name in config.mcp)) return c.json(errorBody("agent_config_mcp_not_found", "MCP server not found"), 404)
      delete config.mcp[name]
      await saveUserConfig(config)
      fanOutConfig().catch(() => {})
      removeAutoHostsForSource(`mcp:${name}`)
      return c.json({ ok: true })
    })
}
