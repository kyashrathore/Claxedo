import type { D1Database } from "@cloudflare/workers-types"
import { APP_PLUGIN_TOOLS_SERVICE } from "@claxedo/mcp/plugin-proxy"
import type { PluginSupervisorNamespace } from "@claxedo/plugin-runtime"
import type { HostedServerPlugin } from "@claxedo/server-core/plugins/server-plugin"
import type { ControlPlaneRouteContribution } from "@claxedo/server-core/platform/http/route-contribution"
import type { AppPluginToolConsent } from "../agent-plugins/app-plugin-tool-consent"
import type { AppPluginsBucket } from "./bundles"
import type { OrgAdministers } from "../credentials/worker/org-administers"
import { appPluginRouteContribution } from "./app-plugin-routes"
import type { OrgCallerInput } from "./org-caller"
import type { AppPluginRegistry } from "./registry"
import { pluginBackendRouteContribution } from "./routes"
import type { PluginToolsGrantKeys } from "./tool-grant"

export type HostedAppPluginsInput = OrgCallerInput &
  Readonly<{
    database: D1Database
    bucket: AppPluginsBucket
    supervisors: PluginSupervisorNamespace
    registry: AppPluginRegistry
    administers: OrgAdministers
    /** Every tool name this deployment's MCP mounts register themselves, which no plugin may declare. */
    reservedToolNames: ReadonlySet<string>
    /** Absent where no MCP mount serves plugin tools. */
    tools?: Readonly<{
      consent: AppPluginToolConsent
      grants?: PluginToolsGrantKeys
      withdraw(orgId: string): Promise<void>
    }>
    now?: () => number
  }>

/**
 * The hosted Worker's app plugins as one composed feature: their routes, and
 * the MCP service through which the hosted endpoint's account credentials
 * reach their tools, as the caller, in this Worker's own process.
 */
export function hostedAppPluginsServerPlugin(input: HostedAppPluginsInput): HostedServerPlugin {
  return {
    id: "app-plugins",
    routeContributions: hostedAppPluginRoutes(input),
    mcp: {
      groups: [],
      service: { id: APP_PLUGIN_TOOLS_SERVICE.id, grant: async ({ inProcessFetch }) => ({ fetch: inProcessFetch({}), operations: ["call"] }) },
    },
  }
}

/** The hosted Worker's app-plugin routes: installs and enablement under `/api/claxedo/app-plugins`, and backends under `/api/plugins`. */
export function hostedAppPluginRoutes(input: HostedAppPluginsInput): ControlPlaneRouteContribution[] {
  const caller: OrgCallerInput = { authentication: input.authentication, authority: input.authority, ...(input.services ? { services: input.services } : {}) }
  const tools = input.tools ? { ...caller, database: input.database, ...input.tools } : undefined
  return [
    appPluginRouteContribution({
      ...caller,
      administers: input.administers,
      lifecycle: {
        database: input.database,
        bucket: input.bucket,
        registry: input.registry,
        supervisors: input.supervisors,
        reservedToolNames: input.reservedToolNames,
        now: input.now ?? Date.now,
      },
      ...(tools ? { tools } : {}),
    }),
    pluginBackendRouteContribution({ ...caller, database: input.database, supervisors: input.supervisors, ...(tools ? { tools } : {}) }),
  ]
}
