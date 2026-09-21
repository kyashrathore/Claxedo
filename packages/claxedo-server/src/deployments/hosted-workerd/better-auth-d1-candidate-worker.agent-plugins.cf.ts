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
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import { createTasksRootCapability, createTasksRootGrant } from "../../tasks/root-capability"
import { createOwnerGrantMinter, createOwnerRootCapability } from "../../session/owner-grant"
import { createD1SandboxPassRegister } from "../../platform/auth/d1-sandbox-pass-register"
import { hostedControlPlaneOrigin } from "../../authority/adapters/worker/control-plane-origin"
import { d1CrossMachineWrites } from "../../authority/adapters/d1/agent-settings"

export { LiveSyncRoom }

export type BetterAuthD1AgentPluginsCandidateWorkerEnv = BetterAuthD1CandidateWorkerEnv & {
  CLAXEDO_AGENT_PLUGINS?: AgentPluginR2Bucket
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
  const base = composeBetterAuthD1UserDeployedControlPlane({
    ...betterAuthD1CandidateCompositionInput(env),
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
  const authority = requireAuthority(base.plane.services)
  if (!authority.resolveWorkspaceOwner) {
    throw new Error("Enabled Agent Plugins build requires an authority that resolves workspace owners")
  }
  const feature = createHostedAgentPluginsComposition({
    env,
    plane: base.plane,
    database: env.CONTROL_PLANE_DB,
    authentication: base.options.authentication,
    tasksGrant: createTasksRootCapability(tasksRoot),
    ownerGrant: createOwnerRootCapability({ signingEnv, passes, workspaceOwner: authority.resolveWorkspaceOwner.bind(authority) }),
    passes,
  })
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
