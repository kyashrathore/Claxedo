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
import { controlPlaneTimeoutMs, withTimeout } from "../control-plane/adapters/convex/timeout"
import type { LlmTurnRecord, UsageLedger } from "./metering"

const usageApi = anyApi as unknown as {
  usageMetering: { recordLlmTurn: unknown; resolveWorkGraphAttribution: unknown }
  sandboxLeases: { recordTenant: unknown }
}

export type ConvexUsageLedgerInput = {
  url?: string
  executor?: ConvexExecutor
  serviceToken?: string
}

export function createConvexUsageLedger(input: ConvexUsageLedgerInput = {}): UsageLedger {
  return {
    resolveWorkGraphAttribution: async (identity) => {
      const executor = requireExecutor(input, undefined, { allowUnsigned: true })
      return await withTimeout(
        executor.query(usageApi.usageMetering.resolveWorkGraphAttribution, {
          ...identity,
          service_token: requireServiceToken(input),
        }),
        controlPlaneTimeoutMs("read"),
      ) as Awaited<ReturnType<NonNullable<UsageLedger["resolveWorkGraphAttribution"]>>>
    },
    recordLlmTurn: async (record: LlmTurnRecord & { org_id: string; user_id: string }) => {
      const executor = requireExecutor(input, undefined, { allowUnsigned: true })
      const result = await withTimeout(
        executor.mutation(usageApi.usageMetering.recordLlmTurn, {
          ...record,
          service_token: requireServiceToken(input),
        }),
        controlPlaneTimeoutMs("mutation"),
      )
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
 *
 * The two identities are shaped the way `sandboxLeases.recordTenant` writes
 * them, so a caller cannot express a state the mutation would reject:
 *
 *  - `owner_subject` is REQUIRED. It is the concurrency cap's attribution key
 *    (`runtime_leases.owner_subject`) and every signed request carries a
 *    subject, so there is no legitimate call that omits it. A lease that was
 *    never stamped is a lease `sandboxLeases.countActiveForOrg` cannot see,
 *    which is a cap that silently does not bind.
 *  - `metering` is the W5 org/user pair. It is ONE optional object rather than
 *    two optional fields so "both or neither" is unrepresentable-otherwise
 *    rather than merely checked: a personal-account token has no org claim, and
 *    a fact keyed on half a tenant — or on an org synthesized to fill the gap —
 *    corrupts every per-org aggregate, so those callers stamp an owner only.
 *    This is why the owner is its own column: it never reaches
 *    `sandbox_lease_events` or the rollups.
 */
export function recordSandboxLeaseTenant(
  input: ConvexUsageLedgerInput & {
    workspace_id: string
    owner_subject: string
    metering?: { org_id: string; user_id: string }
  },
): Promise<{ stamped: boolean }> {
  return (async () => {
    const executor = requireExecutor(input, undefined, { allowUnsigned: true })
    const result = await executor.mutation(usageApi.sandboxLeases.recordTenant, {
      workspace_id: input.workspace_id,
      owner_subject: input.owner_subject,
      // Omitted, not `undefined`: `recordTenant` writes the metering pair only
      // when both are present, and an explicit empty key is not the same thing
      // as an absent optional arg over the wire.
      ...(input.metering ? { org_id: input.metering.org_id, user_id: input.metering.user_id } : {}),
      service_token: requireServiceToken(input),
    })
    return { stamped: (result as { stamped?: unknown } | null)?.stamped === true }
  })().catch(() => ({ stamped: false }))
}
