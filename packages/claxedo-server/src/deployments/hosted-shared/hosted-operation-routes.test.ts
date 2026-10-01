import { expect, test } from "bun:test"
import { Hono } from "hono"
import { HOSTED_OPERATIONS } from "@claxedo/account-contract"
import { createIntegrationsRoutes } from "@claxedo/connections"
import { createHostedCoreApp } from "./hosted-core-app"
import { STATIC_PRODUCT_DESCRIPTORS } from "./deployment-profile"
import { testRequestAuthenticationAdapter } from "../../test-support/request-authentication"
import { hostedAgentPluginsModule } from "../../agent-plugins/module"
import { HostedAgentPluginSourceRoutes } from "../../agent-plugins/sources/routes"
import type { HostedControlPlane } from "../../authority/hosted-services"

function hostedRoutes() {
  const services = {
    auth: { config: { enabled: true }, native: {} },
    authority: {}, relay: {}, sandbox: {}, localExecution: { enabled: false },
    telemetry: { capture() {} },
  }
  const plane = {
    services, env: { CLAXEDO_DEPLOYMENT_MODE: "hosted" },
    privateSessionAuthority: {}, runtimeSessionAuthority: {},
    safetyLimits: {
      connectionRateLimit: 6, connectionRateLimitWindowMs: 60_000,
      controlPlaneRateLimit: 120, controlPlaneRateLimitWindowMs: 60_000,
      defaultRequestRateLimit: 1000, defaultRequestRateLimitWindowMs: 60_000,
    },
  } as unknown as HostedControlPlane
  const module = hostedAgentPluginsModule({ services, selfRuntime: {} } as never)
  const sourceRoutes = HostedAgentPluginSourceRoutes({ services } as never)
  const app = createHostedCoreApp(plane, {
    authentication: testRequestAuthenticationAdapter(),
    product: STATIC_PRODUCT_DESCRIPTORS["claxedo-hosted"],
    requestGuardExemptions: [],
    idempotency: {} as never,
    liveSyncRoom: {} as never,
    sharedRateLimitStore: {} as never,
    cloudWorkspaceAdmission: async () => undefined,
    usageLedger: {} as never,
    integrationRoutes: createIntegrationsRoutes({} as never, { gate: () => null }),
    routeContributions: [
      ...module.routeContributions,
      { id: "sources", path: `${module.routeContributions[0]!.path}/sources`, routes: sourceRoutes },
    ],
  })
  return app.routes
}

const routes = hostedRoutes()

function normalized(path: string) {
  return path.split("?")[0]!.replace(/:[A-Za-z][A-Za-z0-9]*(?:\{[^}]+\})?/g, ":parameter").replace(/\/$/, "")
}

test("every registered operation matches a hosted server route and method", async () => {
  // Cloudflare's DurableObject base class prevents importing the plugin supervisor in Bun.
  const pluginSource = await Bun.file(new URL("../../plugin-backends/routes.ts", import.meta.url)).text()
  const prefix = /PLUGIN_BACKEND_ROUTE_PREFIX = "([^"]+)"/.exec(pluginSource)![1]!
  const rest = /routes\.all\("([^"]+)"/.exec(pluginSource)![1]!
  const pluginRoutes = new Hono().all(`${prefix}${rest}`, () => new Response()).routes
  const allRoutes = [...routes, ...pluginRoutes]
  const missing: string[] = []
  for (const [name, operation] of Object.entries(HOSTED_OPERATIONS)) {
    const methods = typeof operation.method === "string" ? [operation.method] : ["GET", "POST", "PUT", "PATCH", "DELETE"]
    for (const method of methods) {
      const pattern = operation.path.pattern!
      const match = allRoutes.some((route) =>
        (route.method === "ALL" || route.method === method) && normalized(route.path) === normalized(pattern))
      if (!match) missing.push(`${name}: ${method} ${pattern}`)
    }
  }
  expect(missing).toEqual([])
})
