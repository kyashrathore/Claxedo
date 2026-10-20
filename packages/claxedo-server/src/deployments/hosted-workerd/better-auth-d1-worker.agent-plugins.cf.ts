import { composeBetterAuthD1UserDeployedControlPlane } from "../../authority/adapters/worker/better-auth-d1-compose"
import { createHostedAgentPluginsComposition } from "../../agent-plugins/hosted-composition"
import type { AppPluginsBucket } from "../../plugin-backends/bundles"
import {
  betterAuthD1CompositionInput,
  createBetterAuthD1Worker,
  type BetterAuthD1WorkerEnv,
} from "./better-auth-d1-worker.cf"
import { hostedMcpToolGroups, LiveSyncRoom } from "./core-worker.cf"
import { settledCompositionCache } from "./settled-composition-cache"
import { composeHostedTasksPlugin } from "./tasks-plugin/compose"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import { BUILTIN_SUBAGENTS_TOOL_GROUP } from "@claxedo/server-core/agent-plugins/builtin/plugin"
import { createOwnerGrantMinter, createOwnerRootCapability } from "../../session/owner-grant"
import { createD1SandboxPassRegister } from "../../platform/auth/d1-sandbox-pass-register"
import type { SessionRowsPasses } from "../../session/session-rows-pass"
import type { WorkspaceRuntimeContext } from "../../workspace/route-support"
import { HostedWorkerCompositionError } from "../../authority/composition-error"
import { PLUGIN_REGISTRY_KEYS } from "@claxedo/plugin-api/release"
import type { PluginSupervisorNamespace } from "@claxedo/plugin-runtime"
import { hostedOrgAdministers } from "../../credentials/worker/org-administers"
import { hostedAppPluginRoutes } from "../../plugin-backends/compose"
import { DEFAULT_APP_PLUGIN_REGISTRY_URL } from "../../plugin-backends/registry"
import { PluginOutbound, PluginPlatform } from "@claxedo/plugin-runtime/entrypoints"
import { PluginSupervisor } from "../../plugin-backends/supervisor.cf"
import { composeHostedSessionPorts } from "../../plugin-backends/sessions/compose"
import { timedAuthentication, timedD1, timedFetch } from "../../platform/http/server-timing"

export { LiveSyncRoom, PluginOutbound, PluginPlatform, PluginSupervisor }

export type BetterAuthD1AgentPluginsWorkerEnv = BetterAuthD1WorkerEnv & {
  CLAXEDO_AGENT_PLUGINS?: AppPluginsBucket
  PLUGIN_SUPERVISOR?: PluginSupervisorNamespace
}

/** The string-valued half of a Worker env, for the composers that read configuration rather than bindings. */
export function stringEnvironment(
  env: BetterAuthD1AgentPluginsWorkerEnv,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

/**
 * The Agent Plugins composition over the plain Worker.
 *
 * `extra` is what a further feature entry adds to the base composition input —
 * the full-hosted entry passes its sandbox driver and D1 lease store, and the
 * session rows pass its cloud runtimes publish with — so every feature entry
 * shares this one wiring instead of re-declaring it.
 */
export type AppPluginRegistryKeys = (env: BetterAuthD1AgentPluginsWorkerEnv) => Readonly<Record<string, string>>

export function composeBetterAuthD1AgentPlugins(
  env: BetterAuthD1AgentPluginsWorkerEnv,
  extra: Pick<Parameters<typeof composeBetterAuthD1UserDeployedControlPlane>[0], "sandbox"> & {
    sessionRowsPasses?: SessionRowsPasses
    registryKeys?: AppPluginRegistryKeys
  } = {},
) {
  const { sessionRowsPasses, registryKeys, ...input } = extra
  const base = composeBetterAuthD1UserDeployedControlPlane({
    ...betterAuthD1CompositionInput(env),
    ...input,
  })
  const signingEnv = stringEnvironment(env)
  const database = timedD1(env.CONTROL_PLANE_DB)
  const authentication = timedAuthentication(base.options.authentication)
  const passes = createD1SandboxPassRegister({ database })
  const authority = requireAuthority(base.plane.services)
  if (!authority.resolveWorkspaceOwner) {
    throw new Error("Enabled Agent Plugins build requires an authority that resolves workspace owners")
  }
  if (!env.PLUGIN_SUPERVISOR) {
    throw new HostedWorkerCompositionError("hosted_dependency_missing", "The Agent Plugins Worker requires the PLUGIN_SUPERVISOR binding")
  }
  if (!env.CLAXEDO_AGENT_PLUGINS) {
    throw new HostedWorkerCompositionError("hosted_dependency_missing", "The Agent Plugins Worker requires the CLAXEDO_AGENT_PLUGINS bucket")
  }
  const appPlugins = hostedAppPluginRoutes({
    authentication,
    authority,
    services: base.plane.services,
    database,
    bucket: env.CLAXEDO_AGENT_PLUGINS,
    supervisors: env.PLUGIN_SUPERVISOR,
    administers: hostedOrgAdministers(database),
    registry: {
      url: signingEnv.CLAXEDO_APP_PLUGIN_REGISTRY_URL?.trim() || DEFAULT_APP_PLUGIN_REGISTRY_URL,
      keys: registryKeys ? registryKeys(env) : PLUGIN_REGISTRY_KEYS,
      fetch: timedFetch(),
    },
  })
  const sandboxStart = base.options.productWorkspace?.sandboxStart
  const sessions = composeHostedSessionPorts({
    services: base.plane.services,
    database,
    ...(sandboxStart ? { sandboxStart } : {}),
    cloudCreateAdmission: {
      // The same entitlement gate the create route answers through, so an
      // origin's create is billed or refused on the same tenant — the
      // workspace routes' `countActiveOrgSandboxLeases`/`sandboxUsage` and cap
      // knobs apply here by the same name.
      entitlement: base.options.cloudWorkspaceAdmission,
      ...(base.options.productWorkspace?.countActiveOrgSandboxLeases
        ? { countActiveLeases: base.options.productWorkspace.countActiveOrgSandboxLeases }
        : {}),
      ...(base.options.productWorkspace?.sandboxLeaseCap !== undefined
        ? { leaseCap: base.options.productWorkspace.sandboxLeaseCap }
        : {}),
      ...(base.options.productWorkspace?.createWorkspaceRateLimiter
        ? { rateLimiter: base.options.productWorkspace.createWorkspaceRateLimiter }
        : {}),
    },
    ...(base.options.productWorkspace?.sandboxUsage
      ? { sandboxUsage: base.options.productWorkspace.sandboxUsage }
      : {}),
  })
  const tasks = composeHostedTasksPlugin({
    services: base.plane.services,
    database,
    authentication,
    sessions,
    cloudSelectedCapabilities: Boolean(sandboxStart),
    grants: {
      signingEnv,
      passes,
      // Renewal asks the Agent Plugins composition below, which is built after
      // this plugin because its catalog lists this plugin's tool group.
      groupEnabled: (group, root) => feature.groupEnabled(group, root),
      ownerGrant: {
        enabled: (root) => feature.groupEnabled(BUILTIN_SUBAGENTS_TOOL_GROUP, root),
        mint: createOwnerGrantMinter({ signingEnv, passes }),
      },
    },
  })
  const plugins = [tasks]
  const feature = createHostedAgentPluginsComposition({
    toolGroups: hostedMcpToolGroups(plugins),
    env,
    plane: base.plane,
    database,
    authentication,
    fetch: timedFetch(),
    rootGrants: plugins.flatMap((plugin) => plugin.rootGrants ?? []),
    ownerGrant: createOwnerRootCapability({ signingEnv, passes, workspaceOwner: authority.resolveWorkspaceOwner.bind(authority) }),
    passes,
    ...(base.runtimeDelivery ? { pluginsChanged: base.runtimeDelivery.pluginsChanged } : {}),
    ...(base.egressBroker ? { egressBroker: base.egressBroker } : {}),
    ...(base.options.productWorkspace?.sandboxInFlight ? { sandboxInFlight: base.options.productWorkspace.sandboxInFlight } : {}),
  })
  const prepareRuntime = async (context: WorkspaceRuntimeContext) => {
    const [basePreparation, featurePreparation] = await Promise.all([
      base.runtimeDelivery?.prepareRuntime(context),
      feature.prepareRuntime(context),
    ])
    return {
      ...featurePreparation,
      secrets: [...(basePreparation?.secrets ?? []), ...(featurePreparation.secrets ?? [])],
      env: { ...basePreparation?.env, ...featurePreparation.env },
    }
  }
  base.runtimeDelivery?.composeRuntime({ prepareRuntime, pluginRuntime: feature.pluginRuntime })
  return {
    ...base,
    options: {
      ...base.options,
      sandboxPasses: passes,
      ...(sessionRowsPasses ? { sessionRowsPasses } : {}),
      routeContributions: [...feature.routeContributions, ...appPlugins],
      plugins,
      integrationRoutes: feature.integrationRoutes,
      sessionHostPlugins: feature.sessionHostPlugins,
      sessionHostToolGroups: feature.sessionHostToolGroups,
      productWorkspace: {
        ...base.options.productWorkspace,
        connections: { repositoryForAuth: feature.repositoryForAuth },
        releaseRuntime: feature.releaseRuntime,
      },
    },
  }
}

// Same settled-composition rule as the plain Worker: the feature is built
// on top of the base composition inside the one cached constructor, so a
// wedged auth init can never leave a half-featured app behind.
const composition = settledCompositionCache(
  (env: BetterAuthD1AgentPluginsWorkerEnv) => composeBetterAuthD1AgentPlugins(env),
  (created) => created.authReady,
)

const handler = createBetterAuthD1Worker({ composition })
export default handler
