import { HostedWorkerCompositionError } from "../../authority/composition-error"
import { hostedSandboxDriver } from "../../authority/adapters/worker/hosted-sandbox-driver"
import { createD1SandboxLeaseStore } from "../../sandbox/stores/d1"
import { createD1SandboxPassRegister } from "../../platform/auth/d1-sandbox-pass-register"
import { createSessionRowsPasses } from "../../session/session-rows-pass"
import {
  composeBetterAuthD1AgentPlugins,
  PluginOutbound,
  PluginPlatform,
  PluginSupervisor,
  stringEnvironment,
  type BetterAuthD1AgentPluginsWorkerEnv,
} from "./better-auth-d1-worker.agent-plugins.cf"
import { createBetterAuthD1Worker } from "./better-auth-d1-worker.cf"
import { LiveSyncRoom } from "./core-worker.cf"
import { settledCompositionCache } from "./settled-composition-cache"

export { LiveSyncRoom, PluginOutbound, PluginPlatform, PluginSupervisor }

/**
 * The full-hosted Agent Plugins Worker: the Agent Plugins composition plus
 * cloud workspace execution. It is the only entry that bundles a sandbox
 * provider, so a control-plane-only artifact keeps its closure, and it fails
 * closed at composition when the selected driver's configuration is missing —
 * a deployment certified as full-hosted must not quietly serve without VMs.
 *
 * Leases live in `CONTROL_PLANE_DB` (`sandbox/stores/d1.ts`): every isolate of
 * this Worker sees the same acquire/epoch state, which is what makes the
 * manager's stale-takeover and compare-and-set rules hold across isolates.
 */
const composition = settledCompositionCache(
  (env: BetterAuthD1AgentPluginsWorkerEnv) => {
    const driver = hostedSandboxDriver(stringEnvironment(env))
    if (!driver) {
      throw new HostedWorkerCompositionError(
        "sandbox_posture_unsupported",
        "full-hosted entry requires a completely configured CLAXEDO_SANDBOX_DRIVER",
      )
    }
    const leaseStore = createD1SandboxLeaseStore({ database: env.CONTROL_PLANE_DB })
    const sessionRowsPasses = createSessionRowsPasses({
      signingEnv: stringEnvironment(env),
      passes: createD1SandboxPassRegister({ database: env.CONTROL_PLANE_DB }),
      leases: leaseStore,
      workspaceOwner: async (workspaceId) => await composed.plane.services.authority?.resolveWorkspaceOwner?.(workspaceId),
    })
    const composed = composeBetterAuthD1AgentPlugins(env, {
      sandbox: { driver, leaseStore, launchEnv: sessionRowsPasses.launchEnv },
      sessionRowsPasses,
    })
    return composed
  },
  (created) => created.authReady,
)

const handler = createBetterAuthD1Worker({ composition })
export default handler
