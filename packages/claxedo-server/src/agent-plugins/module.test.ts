import { describe, expect, test, vi } from "vitest"
import { AGENT_PLUGINS_ROUTE_PATH } from "@claxedo/server-core/agent-plugins/module"
import { hostedAgentPluginsModule } from "./module"
import { Hono } from "hono"

describe("hostedAgentPluginsModule", () => {
  test("claims the complete route family exactly once", () => {
    const module = hostedAgentPluginsModule({
      services: {} as never,
      sources: vi.fn() as never,
      activations: {} as never,
      artifacts: {} as never,
      reconcile: {} as never,
    })
    expect(module.routeContributions).toHaveLength(1)
    expect(module.routeContributions[0]).toMatchObject({ id: "agent-plugins", path: AGENT_PLUGINS_ROUTE_PATH })
  })

  test("keeps the MCP gateway inside the feature-owned route family", async () => {
    const module = hostedAgentPluginsModule({
      services: {} as never,
      sources: vi.fn() as never,
      activations: {} as never,
      artifacts: {} as never,
      reconcile: {} as never,
      mcpGatewayRoutes: new Hono().post("/:id", (c) => c.text(c.req.param("id"))),
    })
    const routes = module.routeContributions[0]!.routes as Hono
    expect(await (await routes.request("/mcp/integration-1", { method: "POST" })).text()).toBe("integration-1")
  })
})
