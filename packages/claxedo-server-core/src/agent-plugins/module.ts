import type { Hono } from "hono"
import type { ControlPlaneRouteContribution } from "../platform/http/route-contribution"

export const AGENT_PLUGINS_ROUTE_PATH = "/api/claxedo/plugins" as const

export type AgentPluginsModule = {
  routeContributions: readonly ControlPlaneRouteContribution[]
}

/** Creates the one route claim owned by an enabled Agent Plugins build. */
export function agentPluginsModule(routes: Hono): AgentPluginsModule {
  return {
    routeContributions: [{ id: "agent-plugins", path: AGENT_PLUGINS_ROUTE_PATH, routes }],
  }
}
