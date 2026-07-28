/**
 * Convex-backed `UsageLedger` — the authoritative half of the W5 dual-write
 * (plan D1).
 *
 * `usageMetering.recordLlmTurn` is a `serviceMutation`, so this calls it the
 * way the rest of the control plane calls Convex: through a `ConvexExecutor`
 * with the deployment-held service token appended. The token is resolved at
 * CALL time rather than construction time so a deployment that gains its
 * secret after boot starts recording without a restart.
 */

import { anyApi } from "convex/server"
import { requireExecutor, requireServiceToken } from "../control-plane/adapters/convex/convex-authority-executor"
import type { ConvexExecutor } from "../control-plane/adapters/convex/convex-authority-types"
import type { LlmTurnRecord, UsageLedger } from "./metering"

const usageApi = anyApi as unknown as {
  usageMetering: { recordLlmTurn: unknown }
  sandboxLeases: { recordTenant: unknown }
}

export type ConvexUsageLedgerInput = {
  url?: string
  executor?: ConvexExecutor
  serviceToken?: string
}

export function createConvexUsageLedger(input: ConvexUsageLedgerInput = {}): UsageLedger {
  return {
    recordLlmTurn: async (record: LlmTurnRecord & { org_id: string; user_id: string }) => {
      const executor = requireExecutor(input, undefined, { allowUnsigned: true })
      const result = await executor.mutation(usageApi.usageMetering.recordLlmTurn, {
        ...record,
        service_token: requireServiceToken(input),
      })
      const activated = (result as { activated?: unknown } | null)?.activated
      return { activated: activated === true }
    },
  }
}

/**
 * Attribute a sandbox lease to the tenant whose signed request caused it.
 *
 * Best-effort and self-composing: a deployment with no Convex authority or no
 * service token simply records nothing, because a create request must succeed
 * whether or not metering is configured. The caller fires this without
 * awaiting.
 */
export function recordSandboxLeaseTenant(
  input: ConvexUsageLedgerInput & { workspace_id: string; org_id: string; user_id: string },
): Promise<{ stamped: boolean }> {
  return (async () => {
    const executor = requireExecutor(input, undefined, { allowUnsigned: true })
    const result = await executor.mutation(usageApi.sandboxLeases.recordTenant, {
      workspace_id: input.workspace_id,
      org_id: input.org_id,
      user_id: input.user_id,
      service_token: requireServiceToken(input),
    })
    return { stamped: (result as { stamped?: unknown } | null)?.stamped === true }
  })().catch(() => ({ stamped: false }))
}
