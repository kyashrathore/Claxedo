import { HostedWorkerCompositionError } from "../../authority/composition-error"
import { hostedSandboxKeyDrivers } from "../../authority/adapters/worker/hosted-sandbox-key-drivers"
import { sandboxProvisionerClass } from "../../sandbox/provisioner.cf"
import type { SandboxProvisionerNamespace } from "../../workspace/sandbox-start"
import { composeWithCloudSandbox } from "./full-hosted-sandbox"
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

export type BetterAuthD1FullHostedWorkerEnv = BetterAuthD1AgentPluginsWorkerEnv & {
  SANDBOX_PROVISIONER?: SandboxProvisionerNamespace
}

/**
 * The full-hosted Agent Plugins Worker: the Agent Plugins composition plus
 * cloud workspace execution on the organizations' own sandbox provider keys.
 * It is the only entry that bundles the sandbox drivers, so a
 * control-plane-only artifact keeps its closure, and it fails closed at
 * composition when the runtime image those drivers boot is missing — a
 * deployment certified as full-hosted must not quietly serve without VMs.
 *
 * Leases live in `CONTROL_PLANE_DB` (`sandbox/stores/d1.ts`): every isolate of
 * this Worker sees the same acquire/epoch state, which is what makes the
 * manager's stale-takeover and compare-and-set rules hold across isolates.
 * Each workspace's sandbox start runs under its `SandboxProvisioner`.
 */
const composition = settledCompositionCache(
  (env: BetterAuthD1FullHostedWorkerEnv) => {
    if (!env.SANDBOX_PROVISIONER) {
      throw new HostedWorkerCompositionError("hosted_dependency_missing", "The full-hosted Worker requires the SANDBOX_PROVISIONER binding")
    }
    if (!env.LIVE_SYNC_ROOM) {
      throw new HostedWorkerCompositionError("hosted_dependency_missing", "The full-hosted Worker requires the LIVE_SYNC_ROOM binding")
    }
    return composeWithCloudSandbox(
      {
        database: env.CONTROL_PLANE_DB,
        signingEnv: stringEnvironment(env),
        provisioner: env.SANDBOX_PROVISIONER,
        keyDrivers: hostedSandboxKeyDrivers(stringEnvironment(env)),
        room: env.LIVE_SYNC_ROOM,
      },
      (extra) => composeBetterAuthD1AgentPlugins(env, extra),
    )
  },
  (created) => created.authReady,
)

export class SandboxProvisioner extends sandboxProvisionerClass((env: BetterAuthD1FullHostedWorkerEnv) => {
  const delivery = composition(env).runtimeDelivery
  if (!delivery) throw new HostedWorkerCompositionError("hosted_capability_unavailable", "The full-hosted Worker composed no sandbox delivery")
  return delivery.start
}) {}

const handler = createBetterAuthD1Worker({ composition })
export default handler
