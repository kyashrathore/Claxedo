import type { D1Database } from "@cloudflare/workers-types"
import type { PluginSupervisorNamespace } from "@claxedo/plugin-runtime"
import type { ControlPlaneRouteContribution } from "@claxedo/server-core/platform/http/route-contribution"
import type { AgentPluginR2Bucket } from "../agent-plugins/artifacts/r2-artifact-adapter"
import type { OrgAdministers } from "../credentials/worker/org-administers"
import { appPluginRouteContribution } from "./app-plugin-routes"
import type { OrgCallerInput } from "./org-caller"
import type { AppPluginRegistry } from "./registry"
import { pluginBackendRouteContribution } from "./routes"

export type HostedAppPluginsInput = OrgCallerInput &
  Readonly<{
    database: D1Database
    bucket: AgentPluginR2Bucket
    supervisors: PluginSupervisorNamespace
    registry: AppPluginRegistry
    administers: OrgAdministers
    now?: () => number
  }>

/** The hosted Worker's app-plugin routes: installs and enablement under `/api/claxedo/app-plugins`, and backends under `/api/plugins`. */
export function hostedAppPluginRoutes(input: HostedAppPluginsInput): ControlPlaneRouteContribution[] {
  const caller: OrgCallerInput = { authentication: input.authentication, authority: input.authority, ...(input.services ? { services: input.services } : {}) }
  return [
    appPluginRouteContribution({
      ...caller,
      administers: input.administers,
      lifecycle: { database: input.database, bucket: input.bucket, registry: input.registry, supervisors: input.supervisors, now: input.now ?? Date.now },
    }),
    pluginBackendRouteContribution({ ...caller, database: input.database, supervisors: input.supervisors }),
  ]
}
