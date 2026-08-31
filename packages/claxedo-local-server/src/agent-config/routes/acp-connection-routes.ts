import { Hono } from "hono"
import {
  acpConnectionRows,
  loadUserConfig,
  normalizeAcpConnections,
  saveUserConfig,
} from "@claxedo/server-core/agent-config/index"
import { errorBody } from "@claxedo/server-core/platform/http/http"
import { fanOutConfig } from "../fanout"
import { localAgentConfigAllowed } from "../local-auth"
import type { AgentConfigRouteOptions } from "../route-options"

/**
 * Operator-configured ACP connections: the trusted config surface that turns
 * any installed stdio ACP-compatible agent into a selectable harness.
 *
 * The whole proposed map is validated before anything persists — one
 * malformed entry rejects the mutation and leaves the previously accepted
 * config, registry, and fanout snapshot unchanged. Reads serve the sanitized
 * discovery projection only: identity, label, access, and enabled state —
 * never the command or environment.
 */
export function agentConfigAcpConnectionRoutes(options: AgentConfigRouteOptions = {}) {
  return new Hono()
    .get("/harness/acp-connections", async (c) => {
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local ACP connections",
      })
      if (localOnly) return localOnly
      const config = await loadUserConfig()
      return c.json({ connections: acpConnectionRows(config) })
    })

    .put("/harness/acp-connections/:id", async (c) => {
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local ACP connections",
      })
      if (localOnly) return localOnly
      const id = c.req.param("id")
      const body = await c.req.json().catch(() => null)
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return c.json(errorBody("agent_config_invalid_body", "Invalid JSON body"), 400)
      }
      const config = await loadUserConfig()
      // Validate the COMPLETE proposed map — the existing accepted entries plus
      // this one — so acceptance, discovery, and runtime descriptors always
      // derive from one wholly-valid map.
      const proposed = normalizeAcpConnections({ ...(config.acp ?? {}), [id]: body })
      if (proposed.problems.length > 0) {
        return c.json(
          {
            ...errorBody("agent_config_acp_connection_invalid", "ACP connection definition is invalid"),
            problems: proposed.problems,
          },
          400,
        )
      }
      await saveUserConfig({ ...config, acp: proposed.accepted })
      fanOutConfig().catch(() => {})
      return c.json({ ok: true, connections: acpConnectionRows({ acp: proposed.accepted }) })
    })

    .delete("/harness/acp-connections/:id", async (c) => {
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local ACP connections",
      })
      if (localOnly) return localOnly
      const id = c.req.param("id")
      const config = await loadUserConfig()
      if (!config.acp || !(id in config.acp)) {
        return c.json(errorBody("agent_config_acp_connection_not_found", "ACP connection not found"), 404)
      }
      const { [id]: _removed, ...rest } = config.acp
      await saveUserConfig({ ...config, ...(Object.keys(rest).length ? { acp: rest } : { acp: undefined }) })
      fanOutConfig().catch(() => {})
      return c.json({ ok: true })
    })
}
