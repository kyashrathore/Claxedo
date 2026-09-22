import {
  DEFAULT_RECOVERY_BUDGETS,
  type RecoveryBudgets,
} from "@claxedo/agent-runtime-contract"
import {
  reconcileLaunch,
  retire,
  retirementSettled,
  verifyCreationIdentity,
  type LaunchOwnershipRecord,
  type LaunchOwnershipStore,
  type LaunchScope,
  type RetirementResult,
} from "@claxedo/agent-sdk-runtime/launch"
import { Log } from "../log"

const log = Log.create({ service: "launch-ownership-reconcile" })

export type LaunchReconciliation = {
  launchId: string
  role: LaunchOwnershipRecord["role"]
  /** What the launch protocol says about whether the payload ever ran. */
  execution: "none" | "unknown" | "started"
  outcome:
    | "live"
    | "never_executed"
    | "already_gone"
    | "retired"
    | "unresolved"
    | "identity_unavailable"
  retirement?: RetirementResult
  reason: string
}

export type LaunchOwnershipReconciliation = {
  examined: number
  /** Skipped because their owner is the runtime doing the reconciling. */
  live: number
  retired: number
  unresolved: LaunchReconciliation[]
  results: LaunchReconciliation[]
}

/**
 * Reads the launches a previous owner of this scope never finished retiring,
 * and finishes them.
 *
 * It runs before the workspace admits work, because until it has run the
 * processes of that previous owner are still holding this workspace's ports,
 * working directories and agent session storage, and nothing else in the
 * system is looking for them. A row it cannot settle stays open and is
 * returned: an operator is the fallback, never an assumption of exit.
 *
 * A row from `currentOwnerGeneration` is never touched. The store can be
 * reopened in place while its own launches are running, and every one of those
 * rows verifies — signalling them would kill the live workspace this call is
 * preparing.
 */
export async function reconcileLaunchOwnership(
  store: LaunchOwnershipStore,
  input: {
    /** Rows from this generation belong to a runtime that is running now. */
    currentOwnerGeneration: string
    /** Whose launches to finish: this runtime's workspace, or its own store when it serves no workspace. */
    scope: LaunchScope
    budgets?: Partial<RecoveryBudgets>
  },
): Promise<LaunchOwnershipReconciliation> {
  const budgets = { ...DEFAULT_RECOVERY_BUDGETS, ...input.budgets }
  const open = await store.listUnresolved(input.scope)
  const results: LaunchReconciliation[] = []

  for (const record of open) {
    const reconciliation = reconcileLaunch(record)
    const common = { launchId: record.launchId, role: record.role, execution: reconciliation.execution }

    if (record.ownerGeneration === input.currentOwnerGeneration) {
      results.push({
        ...common,
        outcome: "live",
        reason: `owned by the current runtime generation ${record.ownerGeneration}`,
      })
      continue
    }

    if (reconciliation.execution === "none") {
      // The protocol proved the payload never ran, so the row closes with no
      // signal and nothing to look for.
      const retirement: RetirementResult = { leader: "exited", descendants: "verified_clear", signals: [] }
      await store.recordRetirement(record.launchId, retirement)
      results.push({ ...common, outcome: "never_executed", retirement, reason: reconciliation.because })
      continue
    }

    if (!record.identity) {
      results.push({
        ...common,
        outcome: "identity_unavailable",
        reason: "the launch may have executed and no creation identity was ever recorded for it",
      })
      continue
    }

    const verdict = await verifyCreationIdentity(record.identity)
    if (verdict.state === "exited" || verdict.state === "identity_mismatch") {
      // The recorded process is not there. That closes the leader; what it may
      // have left outside its group was never knowable from here.
      const retirement: RetirementResult = { leader: "exited", descendants: "unknown", signals: [] }
      await store.recordRetirement(record.launchId, retirement)
      results.push({
        ...common,
        outcome: "already_gone",
        retirement,
        reason: verdict.state === "exited"
          ? `pid ${record.identity.pid} is gone`
          : `pid ${record.identity.pid} now answers for a different process`,
      })
      continue
    }

    if (verdict.state === "unknown") {
      results.push({ ...common, outcome: "identity_unavailable", reason: verdict.reason })
      continue
    }

    const retirement = await retire({ identity: record.identity }, budgets)
    await store.recordRetirement(record.launchId, retirement)
    results.push({
      ...common,
      outcome: retirementSettled(retirement) ? "retired" : "unresolved",
      retirement,
      reason: retirement.error?.message ?? `pid ${record.identity.pid} was still running and has been retired`,
    })
  }

  const unresolved = results.filter((item) => item.outcome === "unresolved" || item.outcome === "identity_unavailable")
  if (unresolved.length) log.error("launches from a previous owner remain unresolved", { unresolved })
  return {
    examined: results.length,
    live: results.filter((item) => item.outcome === "live").length,
    retired: results.filter((item) => item.outcome === "retired").length,
    unresolved,
    results,
  }
}
