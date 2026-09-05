import { Hono } from "hono"
import {
  connectionRevisionProblems,
  harnessConnectionRows,
  loadUserConfig,
  saveUserConfig,
  validateHarnessConnections,
  type HarnessConnectionDescriptor,
} from "@claxedo/server-core/agent-config/index"
import { errorBody } from "@claxedo/server-core/platform/http/http"
import { fanOutConfig } from "../fanout"
import { localAgentConfigAllowed } from "../local-auth"
import type { AgentConfigRouteOptions } from "../extension-support"

export function agentConfigConnectionRoutes(options: AgentConfigRouteOptions = {}) {
  return new Hono()
    .get("/connections", async (c) => {
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local agent connections",
      })
      if (localOnly) return localOnly
      return c.json({ status: "supported" as const, connections: harnessConnectionRows(await loadUserConfig()) })
    })

    .put("/connections/:connectionId", async (c) => {
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local agent connections",
      })
      if (localOnly) return localOnly
      const connectionId = c.req.param("connectionId")
      const body = await c.req.json().catch(() => undefined)
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return c.json(errorBody("agent_config_invalid_body", "Invalid JSON body"), 400)
      }
      const config = await loadUserConfig()
      const proposed = validateHarnessConnections({
        ...config.connections,
        [connectionId]: body,
      })
      if (proposed.problems.length > 0) {
        return c.json({
          ...errorBody("agent_config_connection_invalid", "Agent connection definition is invalid"),
          problems: proposed.problems,
        }, 400)
      }
      const revisionProblems = connectionRevisionProblems(config.connections, proposed.accepted)
      if (revisionProblems.length > 0) {
        return c.json({
          ...errorBody("agent_config_connection_invalid", "Agent connection definition is invalid"),
          problems: revisionProblems,
        }, 400)
      }
      await saveUserConfig({ ...config, connections: proposed.accepted })
      void fanOutConfig().catch(() => undefined)
      return c.json({
        ok: true,
        connections: harnessConnectionRows({ ...config, connections: proposed.accepted }),
      })
    })

    .delete("/connections/:connectionId", async (c) => {
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local agent connections",
      })
      if (localOnly) return localOnly
      const connectionId = c.req.param("connectionId")
      const config = await loadUserConfig()
      if (!(connectionId in config.connections)) {
        return c.json(errorBody("agent_config_connection_not_found", "Agent connection not found"), 404)
      }
      const connections = withoutConnection(config.connections, connectionId)
      await saveUserConfig({
        ...config,
        connections,
        ...(config.defaultConnectionId === connectionId ? { defaultConnectionId: undefined } : {}),
      })
      void fanOutConfig().catch(() => undefined)
      return c.json({ ok: true })
    })
}

function withoutConnection(
  connections: Record<string, HarnessConnectionDescriptor>,
  connectionId: string,
) {
  return Object.fromEntries(Object.entries(connections).filter(([id]) => id !== connectionId))
}
