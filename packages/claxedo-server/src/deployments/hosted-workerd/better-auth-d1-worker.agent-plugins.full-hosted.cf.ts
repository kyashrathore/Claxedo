import { HostedWorkerCompositionError } from "../../authority/composition-error"
import { hostedSandboxDriver } from "../../authority/adapters/worker/hosted-sandbox-driver"
import { createD1SandboxLeaseStore } from "../../sandbox/stores/d1"
import { createD1SandboxPassRegister } from "../../platform/auth/d1-sandbox-pass-register"
import { createCloudSessionRowsLaunchEnvironment } from "../../session/cloud-session-rows-launch"
import { hostedControlPlaneOrigin } from "../../authority/adapters/worker/control-plane-origin"
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
    const signingEnv = stringEnvironment(env)
    const passes = createD1SandboxPassRegister({ database: env.CONTROL_PLANE_DB })
    const controlPlaneOrigin = hostedControlPlaneOrigin(signingEnv)
    if (!controlPlaneOrigin || !signingEnv.CLAXEDO_DEPLOYMENT_ID) throw new Error("Cloud session publication requires the control-plane origin and deployment id")
    const driver = hostedSandboxDriver(signingEnv, {
      runtimeEnv: createCloudSessionRowsLaunchEnvironment({
        database: env.CONTROL_PLANE_DB, deploymentId: signingEnv.CLAXEDO_DEPLOYMENT_ID,
        signingEnv, passes, controlPlaneOrigin,
      }),
    })
    if (!driver) {
      throw new HostedWorkerCompositionError(
        "sandbox_posture_unsupported",
        "full-hosted entry requires a completely configured CLAXEDO_SANDBOX_DRIVER",
      )
    }
    const selected = composeBetterAuthD1AgentPlugins(env, {
      sandbox: {
        driver,
        leaseStore: createD1SandboxLeaseStore({ database: env.CONTROL_PLANE_DB }),
      },
    })
    selected.options.cloudSessionRows = { signingEnv, passes }
    return selected
  },
  (created) => created.authReady,
)

const handler = createBetterAuthD1Worker({ composition })
export default handler
