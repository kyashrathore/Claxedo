/**
 * The Agent Plugins build of the phase-gated user-deployed candidate Worker.
 *
 * Feature selection is an import-graph fact: this entry is the only file that
 * reaches `agent-plugins/hosted-composition.ts` and the hosted D1 Connections
 * setup. The plain candidate entry closes over neither, and the
 * deployment-closure test holds both facts.
 */
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

// Same settled-composition rule as the plain candidate: the feature is built
// on top of the base composition inside the one cached constructor, so a
// wedged auth init can never leave a half-featured app behind.
const composition = settledCompositionCache(
  (env: BetterAuthD1AgentPluginsCandidateWorkerEnv) => {
    const base = composeBetterAuthD1UserDeployedControlPlane(betterAuthD1CandidateCompositionInput(env))
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
  },
  (created) => created.authReady,
)

const handler = createBetterAuthD1CandidateWorker({ composition })

export default handler
