import { composeBetterAuthD1UserDeployedControlPlane } from "../../authority/adapters/worker/better-auth-d1-compose"
import { createHostedAgentPluginsComposition } from "../../agent-plugins/hosted-composition"
import type { AgentPluginR2Bucket } from "../../agent-plugins/artifacts/r2-artifact-adapter"
import {
  betterAuthD1CompositionInput,
  createBetterAuthD1Worker,
  type BetterAuthD1WorkerEnv,
} from "./better-auth-d1-worker.cf"
import { LiveSyncRoom } from "./core-worker.cf"
import { settledCompositionCache } from "./settled-composition-cache"
import { hostedTasksRouteContributions } from "./tasks-contributions"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import { createTasksRootCapability, createTasksRootGrant } from "../../tasks/root-capability"
import { createOwnerGrantMinter, createOwnerRootCapability } from "../../session/owner-grant"
import { createD1SandboxPassRegister } from "../../platform/auth/d1-sandbox-pass-register"
import { hostedControlPlaneOrigin } from "../../authority/adapters/worker/control-plane-origin"
import type { WorkspaceRuntimeContext } from "../../workspace/route-support"
import { HostedWorkerCompositionError } from "../../authority/composition-error"
import { pluginBackendRouteContribution } from "../../plugin-backends/routes"
import { PluginSupervisor, type PluginSupervisorNamespace } from "../../plugin-backends/supervisor.cf"
import { PluginOutbound, PluginPlatform } from "../../plugin-backends/entrypoints.cf"

export { LiveSyncRoom, PluginOutbound, PluginPlatform, PluginSupervisor }

export type BetterAuthD1AgentPluginsWorkerEnv = BetterAuthD1WorkerEnv & {
  CLAXEDO_AGENT_PLUGINS?: AgentPluginR2Bucket
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
 * the full-hosted entry passes its sandbox driver and D1 lease store — so every
 * feature entry shares this one wiring instead of re-declaring it.
 */
export function composeBetterAuthD1AgentPlugins(
  env: BetterAuthD1AgentPluginsWorkerEnv,
  extra: Pick<Parameters<typeof composeBetterAuthD1UserDeployedControlPlane>[0], "sandbox"> = {},
) {
  const base = composeBetterAuthD1UserDeployedControlPlane({
    ...betterAuthD1CompositionInput(env),
    ...extra,
  })
  const signingEnv = stringEnvironment(env)
  const passes = createD1SandboxPassRegister({ database: env.CONTROL_PLANE_DB })
  const tasksRoot = { signingEnv, passes }
  const authority = requireAuthority(base.plane.services)
  if (!authority.resolveWorkspaceOwner) {
    throw new Error("Enabled Agent Plugins build requires an authority that resolves workspace owners")
  }
  if (!env.PLUGIN_SUPERVISOR) {
    throw new HostedWorkerCompositionError("hosted_dependency_missing", "The Agent Plugins Worker requires the PLUGIN_SUPERVISOR binding")
  }
  const pluginBackends = pluginBackendRouteContribution({
    authentication: base.options.authentication,
    authority,
    supervisors: env.PLUGIN_SUPERVISOR,
    services: base.plane.services,
  })
  const feature = createHostedAgentPluginsComposition({
    env,
    plane: base.plane,
    database: env.CONTROL_PLANE_DB,
    authentication: base.options.authentication,
    tasksGrant: createTasksRootCapability(tasksRoot),
    ownerGrant: createOwnerRootCapability({ signingEnv, passes, workspaceOwner: authority.resolveWorkspaceOwner.bind(authority) }),
    passes,
    ...(base.runtimeDelivery ? { pluginsChanged: base.runtimeDelivery.pluginsChanged, pushRuntime: base.runtimeDelivery.provisionRuntime } : {}),
  })
  const prepareRuntime = async (context: WorkspaceRuntimeContext) => {
    const [basePreparation, featurePreparation] = await Promise.all([
      base.options.productWorkspace?.prepareRuntime?.(context),
      feature.prepareRuntime(context),
    ])
    return {
      ...featurePreparation,
      secrets: [...(basePreparation?.secrets ?? []), ...(featurePreparation.secrets ?? [])],
      env: { ...basePreparation?.env, ...featurePreparation.env },
    }
  }
  base.runtimeDelivery?.composeRuntime({ prepareRuntime, pluginRuntime: feature.pluginRuntime })
  const tasks = hostedTasksRouteContributions({
    services: base.plane.services,
    database: env.CONTROL_PLANE_DB,
    authentication: base.options.authentication,
    selectedCapabilities: feature.selectedCapabilities,
    rootEnvironment: feature.rootEnvironment,
    releaseRuntime: feature.releaseRuntime,
    cloudCreateAdmission: {
      // The same entitlement gate the create route answers through, so a
      // task-driven create is billed or refused on the same tenant — the
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
    sandboxEgress: { controlPlaneOrigin: hostedControlPlaneOrigin(signingEnv) },
    signingEnv,
    passes,
    renewal: {
      tasksGroupEnabled: feature.tasksGroupEnabled,
      grant: createTasksRootGrant(tasksRoot),
      ownerGrant: { enabled: feature.subagentsGroupEnabled, mint: createOwnerGrantMinter({ signingEnv, passes }) },
    },
  })
  return {
    ...base,
    options: {
      ...base.options,
      sandboxPasses: passes,
      routeContributions: [...feature.routeContributions, ...tasks, pluginBackends],
      integrationRoutes: feature.integrationRoutes,
      productWorkspace: {
        ...base.options.productWorkspace,
        prepareRuntime,
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
