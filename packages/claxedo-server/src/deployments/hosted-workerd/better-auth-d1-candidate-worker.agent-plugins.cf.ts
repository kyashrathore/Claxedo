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
 * Tasks, or nothing at all, decided when this artifact is built.
 *
 * The release renders the comparison below into the Wrangler config's
 * `[define]`, so esbuild folds it to a literal and an off deployment carries
 * no Tasks code to serve — the staged `migrations_dir` the same renderer names
 * leaves its D1 tables out too.
 *
 * The import expression itself has to sit in the folded branch. Measured on
 * this entry: a folded `if` around a static import still emitted all three
 * `src/tasks` modules and kept the kit's route factory, because esbuild drops
 * a module only when nothing references it at all. Awaiting it at module scope
 * keeps composition synchronous, which the settled-composition rule below
 * depends on.
 */
const tasksRouteContributions =
  process.env.CLAXEDO_BUILD_TASKS !== "0"
    ? (await import("./tasks-contributions")).hostedTasksRouteContributions
    : undefined

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
    database: env.CONTROL_PLANE_DB,
    authentication: base.options.authentication,
  })
  const tasks =
    tasksRouteContributions?.({
      services: base.plane.services,
      database: env.CONTROL_PLANE_DB,
      authentication: base.options.authentication,
      selectedCapabilities: feature.selectedCapabilities,
    }) ?? []
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
