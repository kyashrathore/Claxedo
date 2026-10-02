import { expect, test, vi } from "vitest"
import { HOSTED_OPERATIONS } from "@claxedo/account-contract"
import { createIntegrationsRoutes } from "@claxedo/connections"
import { AGENT_PLUGINS_ROUTE_PATH } from "@claxedo/server-core/agent-plugins/module"
import { asOrgId } from "@claxedo/server-core/platform/auth/branded-id"
import { createHostedCoreApp } from "./hosted-core-app"
import { STATIC_PRODUCT_DESCRIPTORS } from "./deployment-profile"
import { testRequestAuthenticationAdapter } from "../../test-support/request-authentication"
import { hostedAgentPluginsModule } from "../../agent-plugins/module"
import { HostedAgentPluginSourceRoutes } from "../../agent-plugins/sources/routes"
import { pluginBackendRouteContribution } from "../../plugin-backends/routes"
import type { HostedControlPlane } from "../../authority/hosted-services"

// The supervisor extends Cloudflare's DurableObject, which only workerd provides.
vi.mock("../../plugin-backends/supervisor.cf", () => ({ pluginSupervisor: vi.fn() }))

/** The routes the full hosted product serves: the core app with Pages, Agent Plugins and plugin backends. */
function hostedRoutes() {
  const services = {
    auth: { config: { enabled: true }, native: {} },
    authority: {},
    relay: {},
    sandbox: {},
    localExecution: { enabled: false },
    telemetry: { capture() {} },
  }
  const plane = {
    services,
    env: { CLAXEDO_DEPLOYMENT_MODE: "hosted" },
    privateSessionAuthority: {},
    runtimeSessionAuthority: {},
    safetyLimits: {
      connectionRateLimit: 6,
      connectionRateLimitWindowMs: 60_000,
      controlPlaneRateLimit: 120,
      controlPlaneRateLimitWindowMs: 60_000,
      defaultRequestRateLimit: 1000,
      defaultRequestRateLimitWindowMs: 60_000,
    },
  } as unknown as HostedControlPlane
  const authentication = testRequestAuthenticationAdapter()
  const module = hostedAgentPluginsModule({ services, selfRuntime: {} } as never)
  const app = createHostedCoreApp(plane, {
    authentication,
    product: STATIC_PRODUCT_DESCRIPTORS["claxedo-hosted"],
    requestGuardExemptions: [],
    idempotency: {} as never,
    liveSyncRoom: {} as never,
    sharedRateLimitStore: {} as never,
    cloudWorkspaceAdmission: async () => undefined,
    usageLedger: {} as never,
    documents: {} as never,
    integrationRoutes: createIntegrationsRoutes({} as never, { gate: () => null }),
    routeContributions: [
      ...module.routeContributions,
      {
        id: "agent-plugins-sources",
        path: `${AGENT_PLUGINS_ROUTE_PATH}/sources`,
        routes: HostedAgentPluginSourceRoutes({ services } as never),
      },
      pluginBackendRouteContribution({
        authentication,
        authority: { resolveOrgId: async () => asOrgId("org") },
        supervisors: {} as never,
      }),
    ],
  })
  return app.routes
}

function normalized(path: string) {
  return path
    .split("?")[0]
    .replace(/:[A-Za-z][A-Za-z0-9]*(?:\{[^}]+\})?/g, ":parameter")
    .replace(/\/$/, "")
}

test("every registered operation matches a hosted server route and method", () => {
  const routes = hostedRoutes()
  const missing: string[] = []
  for (const [name, operation] of Object.entries(HOSTED_OPERATIONS)) {
    const methods =
      typeof operation.method === "string" ? [operation.method] : ["GET", "POST", "PUT", "PATCH", "DELETE"]
    for (const method of methods) {
      const pattern = operation.path.pattern!
      const served = routes.some(
        (route) =>
          (route.method === "ALL" || route.method === method) && normalized(route.path) === normalized(pattern),
      )
      if (!served) missing.push(`${name}: ${method} ${pattern}`)
    }
  }
  expect(missing).toEqual([])
})
