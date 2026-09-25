import { Hono } from "hono"
import { loadUserConfig, saveUserConfig } from "@claxedo/server-core/agent-config/index"
import { AgentConfigMutationError, deleteMcpServer, putMcpServer } from "@claxedo/server-core/agent-config/mutations"
import { fanOutConfig } from "../fanout"
import { ensureHostForUrl, removeAutoHostsForSource } from "@claxedo/server-core/sandbox/network/policy"
import { errorBody } from "@claxedo/server-core/platform/http/http"
import { localAgentConfigAllowed } from "../local-auth"
import type { AgentConfigRouteOptions } from "../route-options"
import { record } from "../../platform/json"
import {
  HostedMcpUrlError,
  installHostedMcpEntry,
  removeHostedMcpEntry,
} from "../hosted-mcp-install"

const store = { read: loadUserConfig, write: saveUserConfig }

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
      try {
        const name = c.req.param("name")
        const server = await putMcpServer(store, name, await c.req.json())
        if (server.type === "remote" && server.url) ensureHostForUrl(server.url, `mcp:${name}`)
        await fanOutConfig()
        return c.json({ ok: true, name })
      } catch (error) {
        if (error instanceof AgentConfigMutationError) return c.json(errorBody(error.code, error.message), error.status)
        throw error
      }
    })
    .delete("/mcp/:name", async (c) => {
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local MCP config",
      })
      if (localOnly) return localOnly
      try {
        const name = c.req.param("name")
        await deleteMcpServer(store, name)
        removeAutoHostsForSource(`mcp:${name}`)
        await fanOutConfig()
        return c.json({ ok: true })
      } catch (error) {
        if (error instanceof AgentConfigMutationError) return c.json(errorBody(error.code, error.message), error.status)
        throw error
      }
    })
}
