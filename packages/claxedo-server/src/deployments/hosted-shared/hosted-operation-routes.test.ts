import { expect, test } from "vitest"
import { hostedOperationTable } from "@claxedo/account-contract"
import { DOCUMENTS_OPERATIONS } from "@claxedo/documents/operations"
import { createIntegrationsRoutes } from "@claxedo/connections"
import { AGENT_PLUGINS_ROUTE_PATH } from "@claxedo/server-core/agent-plugins/module"
import { asOrgId } from "@claxedo/server-core/platform/auth/branded-id"
import { createHostedCoreApp } from "./hosted-core-app"
import { STATIC_PRODUCT_DESCRIPTORS } from "./deployment-profile"
import { testRequestAuthenticationAdapter } from "../../test-support/request-authentication"
import { hostedAgentPluginsModule } from "../../agent-plugins/module"
import { HostedAgentPluginSourceRoutes } from "../../agent-plugins/sources/routes"
import { hostedAppPluginRoutes } from "../../plugin-backends/compose"
import { composeHostedDocumentsPlugin } from "../../documents/compose"
import type { HostedControlPlane } from "../../authority/hosted-services"

/** The routes the full hosted product serves: the core app with Pages, Agent Plugins, app plugins and their backends and the account setup the Worker composition always mounts (`better-auth-d1-compose.ts`), which holds the credential routes. */
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
    env: { CLAXEDO_DEPLOYMENT_MODE: "hosted", CLAXEDO_CREDENTIALS_KEK: Buffer.alloc(32, 3).toString("base64") },
    orgCredentials: () => ({}),
    resolverToken: "relay-resolver-secret",
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
    plugins: [
      composeHostedDocumentsPlugin({ bucket: {} as never, plane, access: {} as never, authentication, rateLimit: async () => true }),
    ],
    integrationRoutes: createIntegrationsRoutes({} as never, { gate: () => null }),
    accountSetup: { change: {} as never, administers: async () => true },
    routeContributions: [
      ...module.routeContributions,
      {
        id: "agent-plugins-sources",
        path: `${AGENT_PLUGINS_ROUTE_PATH}/sources`,
        routes: HostedAgentPluginSourceRoutes({ services } as never),
      },
      ...hostedAppPluginRoutes({
        authentication,
        authority: { resolveOrgId: async () => asOrgId("org") },
        database: {} as never,
        bucket: {} as never,
        supervisors: {} as never,
        registry: {} as never,
        administers: async () => true,
        reservedToolNames: new Set(),
        tools: { consent: {} as never, withdraw: async () => undefined },
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
  for (const [name, operation] of Object.entries(hostedOperationTable(DOCUMENTS_OPERATIONS).operations)) {
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
