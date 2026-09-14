import type { CloudflareKvNamespaceBinding } from "@claxedo/server-core/credentials/backends/cloudflare"
import { composeBetterAuthD1UserDeployedControlPlane } from "../../authority/adapters/worker/better-auth-d1-compose"
import { createHostedAgentPluginsComposition } from "../../agent-plugins/hosted-composition"
import type { AgentPluginR2Bucket } from "../../agent-plugins/artifacts/r2-artifact-adapter"
import {
  betterAuthD1CandidateCompositionInput,
  createBetterAuthD1CandidateWorker,
  type BetterAuthD1CandidateWorkerEnv,
} from "./better-auth-d1-candidate-worker.cf"
import { LiveSyncRoom } from "./core-worker.cf"
import { settledCompositionCache } from "./settled-composition-cache"
import { hostedTasksRouteContributions } from "./tasks-contributions"
import { createTasksRootCapability, createTasksRootGrant } from "../../tasks/root-capability"
import { createD1SandboxPassRegister } from "../../platform/auth/d1-sandbox-pass-register"
import { hostedControlPlaneOrigin } from "../../authority/adapters/worker/control-plane-origin"
import { d1CrossMachineWrites } from "../../authority/adapters/d1/agent-settings"

export { LiveSyncRoom }

export type BetterAuthD1AgentPluginsCandidateWorkerEnv = BetterAuthD1CandidateWorkerEnv & {
  CLAXEDO_AGENT_PLUGINS?: AgentPluginR2Bucket
  CLAXEDO_CREDENTIALS?: CloudflareKvNamespaceBinding
}

/** The string-valued half of a Worker env, for the composers that read configuration rather than bindings. */
export function stringEnvironment(
  env: BetterAuthD1AgentPluginsCandidateWorkerEnv,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

/**
 * The Agent Plugins composition over the plain candidate.
 *
 * `extra` is what a further feature entry adds to the base composition input —
 * the full-hosted entry passes its sandbox driver and D1 lease store — so every
 * feature entry shares this one wiring instead of re-declaring it.
 */
export function composeBetterAuthD1AgentPluginsCandidate(
  env: BetterAuthD1AgentPluginsCandidateWorkerEnv,
  extra: Pick<Parameters<typeof composeBetterAuthD1UserDeployedControlPlane>[0], "sandbox"> = {},
) {
  // The credentials KV binding is an object, so it cannot ride in the
  // string-only composition env; the base plane needs it for
  // `workerCredentials`, which the hosted-credentials flag turns on.
  const base = composeBetterAuthD1UserDeployedControlPlane({
    ...betterAuthD1CandidateCompositionInput(env),
    ...(env.CLAXEDO_CREDENTIALS ? { credentialsNamespace: env.CLAXEDO_CREDENTIALS } : {}),
    ...extra,
  })
  // One signing key decides both halves: the deployment that mints a root's
  // Tasks grant is exactly the one whose routes will verify it.
  const signingEnv = stringEnvironment(env)
  // Every pass a root is launched with is written here, and every verifier
  // asks here first: the switch and the workspace's deletion revoke by
  // workspace, and a renewal is refused for a revoked grant like any request.
  const passes = createD1SandboxPassRegister({ database: env.CONTROL_PLANE_DB })
  // One input for the launch grant and the renewed one, so `start` follows
  // the account's setting at both.
  const tasksRoot = { signingEnv, passes, crossMachineWrites: d1CrossMachineWrites(env.CONTROL_PLANE_DB) }
  const feature = createHostedAgentPluginsComposition({
    env,
    plane: base.plane,
    database: env.CONTROL_PLANE_DB,
    authentication: base.options.authentication,
    tasksGrant: createTasksRootCapability(tasksRoot),
    passes,
  })
  const tasks = hostedTasksRouteContributions({
    services: base.plane.services,
    database: env.CONTROL_PLANE_DB,
    authentication: base.options.authentication,
    selectedCapabilities: feature.selectedCapabilities,
    rootEnvironment: feature.rootEnvironment,
    releaseRuntime: feature.releaseRuntime,
    sandboxEgress: { controlPlaneOrigin: hostedControlPlaneOrigin(signingEnv) },
    signingEnv,
    passes,
    renewal: { tasksGroupEnabled: feature.tasksGroupEnabled, grant: createTasksRootGrant(tasksRoot) },
  })
  return {
    ...base,
    options: {
      ...base.options,
      routeContributions: [...feature.routeContributions, ...tasks],
      integrationRoutes: feature.integrationRoutes,
      productWorkspace: {
        ...base.options.productWorkspace,
        prepareRuntime: feature.prepareRuntime,
        provisionRuntime: feature.provisionRuntime,
        releaseRuntime: feature.releaseRuntime,
      },
    },
  }
}

// Same settled-composition rule as the plain candidate: the feature is built
// on top of the base composition inside the one cached constructor, so a
// wedged auth init can never leave a half-featured app behind.
const composition = settledCompositionCache(
  (env: BetterAuthD1AgentPluginsCandidateWorkerEnv) => composeBetterAuthD1AgentPluginsCandidate(env),
  (created) => created.authReady,
)

const handler = createBetterAuthD1CandidateWorker({ composition })
export default handler
