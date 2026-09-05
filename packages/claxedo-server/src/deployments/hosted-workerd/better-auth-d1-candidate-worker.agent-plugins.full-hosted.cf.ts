import type { D1Database } from "@cloudflare/workers-types"
import { HostedWorkerCompositionError } from "../../authority/composition-error"
import { hostedSandboxDriver } from "../../authority/adapters/worker/hosted-sandbox-driver"
import { createD1SandboxLeaseStore } from "../../sandbox/stores/d1"
import {
  composeBetterAuthD1AgentPluginsCandidate,
  type BetterAuthD1AgentPluginsCandidateWorkerEnv,
} from "./better-auth-d1-candidate-worker.agent-plugins.cf"
import { createBetterAuthD1CandidateWorker } from "./better-auth-d1-candidate-worker.cf"
import { LiveSyncRoom } from "./core-worker.cf"
import { settledCompositionCache } from "./settled-composition-cache"

export { LiveSyncRoom }

/**
 * The full-hosted Agent Plugins candidate: the Agent Plugins composition plus
 * cloud workspace execution. It is the only entry that bundles a sandbox
 * provider, so a control-plane-only artifact keeps its closure, and it fails
 * closed at composition when the selected driver's configuration is missing —
 * a deployment certified as full-hosted must not quietly serve without VMs.
 *
 * Leases live in `CONTROL_PLANE_DB` (`sandbox/stores/d1.ts`): every isolate of
 * this Worker sees the same acquire/epoch state, which is what makes the
 * manager's stale-takeover and compare-and-set rules hold across isolates.
 */
function stringEnvironment(env: BetterAuthD1AgentPluginsCandidateWorkerEnv): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

const composition = settledCompositionCache(
  (env: BetterAuthD1AgentPluginsCandidateWorkerEnv) => {
    const driver = hostedSandboxDriver(stringEnvironment(env))
    if (!driver) {
      throw new HostedWorkerCompositionError(
        "sandbox_posture_unsupported",
        "full-hosted entry requires a completely configured CLAXEDO_SANDBOX_DRIVER",
      )
    }
    return composeBetterAuthD1AgentPluginsCandidate(env, {
      sandbox: {
        driver,
        leaseStore: createD1SandboxLeaseStore({ database: env.CONTROL_PLANE_DB as D1Database }),
      },
    })
  },
  (created) => created.authReady,
)

const handler = createBetterAuthD1CandidateWorker({ composition })
export default handler
