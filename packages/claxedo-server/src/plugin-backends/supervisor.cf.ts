import type { D1Database } from "@cloudflare/workers-types"
import type { PluginHostPort } from "@claxedo/plugin-runtime"
import { pluginSupervisorClass, type PluginRuntimeEnv } from "@claxedo/plugin-runtime/supervisor"
import type { AgentPluginR2Bucket } from "../agent-plugins/artifacts/r2-artifact-adapter"
import { readPluginBackendState } from "./activations"
import { readPluginBackendBundle } from "./bundles"

export type HostedPluginBackendEnv = PluginRuntimeEnv & {
  CONTROL_PLANE_DB: D1Database
  CLAXEDO_AGENT_PLUGINS: AgentPluginR2Bucket
}

/** The hosted Worker's answers to the runtime: the install row in D1 and the bundle in the plugin artifact bucket. */
export function hostedPluginHostPort(env: HostedPluginBackendEnv): PluginHostPort {
  return {
    readState: (orgId, pluginId) => readPluginBackendState(env.CONTROL_PLANE_DB, orgId, pluginId),
    readBundle: (sha256) => readPluginBackendBundle(env.CLAXEDO_AGENT_PLUGINS, sha256),
  }
}

export class PluginSupervisor extends pluginSupervisorClass(hostedPluginHostPort) {}
