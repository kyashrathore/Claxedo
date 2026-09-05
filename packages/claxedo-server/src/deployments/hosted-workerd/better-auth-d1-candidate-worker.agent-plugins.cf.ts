import type { D1Database } from "@cloudflare/workers-types"
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

export { LiveSyncRoom }

export type BetterAuthD1AgentPluginsCandidateWorkerEnv = BetterAuthD1CandidateWorkerEnv & {
  CLAXEDO_AGENT_PLUGINS?: AgentPluginR2Bucket
  CLAXEDO_CREDENTIALS?: CloudflareKvNamespaceBinding
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
  const feature = createHostedAgentPluginsComposition({
    env,
    plane: base.plane,
    database: env.CONTROL_PLANE_DB as D1Database,
    authentication: base.options.authentication,
  })
  return {
    ...base,
    options: {
      ...base.options,
      routeContributions: feature.routeContributions,
      integrationRoutes: feature.integrationRoutes,
      productWorkspace: {
        ...(base.options.productWorkspace ?? {}),
        prepareRuntime: feature.prepareRuntime,
        provisionRuntime: feature.provisionRuntime,
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
