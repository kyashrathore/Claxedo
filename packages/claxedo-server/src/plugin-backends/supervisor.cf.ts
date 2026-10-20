import type { D1Database } from "@cloudflare/workers-types"
import type { PluginHostPort } from "@claxedo/plugin-runtime"
import { pluginSupervisorClass, type PluginRuntimeEnv } from "@claxedo/plugin-runtime/supervisor"
import type { AgentPluginR2Bucket } from "../agent-plugins/artifacts/r2-artifact-adapter"
import { readPluginBundle } from "./bundles"
import { readPluginBackendState } from "./installs"

export type HostedPluginBackendEnv = PluginRuntimeEnv & {
  CONTROL_PLANE_DB: D1Database
  CLAXEDO_AGENT_PLUGINS: AgentPluginR2Bucket
}

/** The hosted Worker's answers to the runtime: the install in D1 and the backend bundle in the plugin artifact bucket. */
export function hostedPluginHostPort(env: HostedPluginBackendEnv): PluginHostPort {
  return {
    readState: (orgId, pluginId) => readPluginBackendState(env.CONTROL_PLANE_DB, orgId, pluginId),
    readBundle: (sha256) => readPluginBundle(env.CLAXEDO_AGENT_PLUGINS, "backend", sha256),
  }
}

export class PluginSupervisor extends pluginSupervisorClass(hostedPluginHostPort) {}
