import { Hono } from "hono"
import { loadUserConfig, saveUserConfig } from "@claxedo/server-core/agent-config/index"
import { fanOutConfig } from "../fanout"
import { ensureHostForUrl, removeAutoHostsForSource } from "@claxedo/server-core/sandbox/network/policy"
import { errorBody } from "@claxedo/server-core/platform/http/http"
import { localAgentConfigAllowed } from "../local-auth"
import type { AgentConfigRouteOptions } from "../route-options"
import { record, stringRecord } from "../../platform/json"
import {
  HostedMcpUrlError,
  installHostedMcpEntry,
  removeHostedMcpEntry,
} from "../hosted-mcp-install"

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

    /**
     * One click from the desktop: put the hosted `claxedo` MCP entry into the
     * harness apps installed on this machine.
     *
     * Registered ahead of `/mcp/:name` so the parameter route cannot claim it.
     */
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

      const body = record(await c.req.json().catch(() => null))
      if (!body) {
        return c.json(errorBody("agent_config_invalid_body", "Invalid JSON body"), 400)
      }

      const { type, command, args, env, url, headers, disabled } = body
      const optional = typeof disabled === "boolean" ? { disabled } : {}

      if (type !== "stdio" && type !== "remote") {
        return c.json(errorBody("agent_config_mcp_type_invalid", "type must be 'stdio' or 'remote'"), 400)
      }
      const config = await loadUserConfig()
      // The two server kinds are written in their own branch so each required
      // field is checked and used in one place: a combined object had to
      // re-state, unchecked, what its own guard had already proved.
      if (type === "stdio") {
        if (typeof command !== "string") {
          return c.json(errorBody("agent_config_mcp_command_required", "command is required for stdio servers"), 400)
        }
        config.mcp[name] = {
          type,
          command,
          args: Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === "string") : [],
          env: stringRecord(env),
          ...optional,
        }
        await saveUserConfig(config)
        fanOutConfig().catch(() => {})
        return c.json({ ok: true, name })
      }

      if (typeof url !== "string") {
        return c.json(errorBody("agent_config_mcp_url_required", "url is required for remote servers"), 400)
      }
      config.mcp[name] = { type, url, headers: stringRecord(headers), ...optional }
      await saveUserConfig(config)
      fanOutConfig().catch(() => {})
      ensureHostForUrl(url, `mcp:${name}`)

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
