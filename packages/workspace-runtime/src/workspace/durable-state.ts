import { DEFAULT_RECOVERY_BUDGETS, type AgentSessionStarts } from "@claxedo/agent-runtime-contract"
import type { LaunchOwnershipOwner, LaunchOwnershipStore } from "@claxedo/process-ownership/launch"
import { HTTPException } from "hono/http-exception"
import { sqliteLaunchOwnership } from "../ownership/launch-ownership-sqlite"
import { reconcileLaunchOwnership, type LaunchOwnershipReconciliation } from "../ownership/reconcile-launch-ownership"
import { errorBody } from "../routes/error-body"
import type { RuntimeStore } from "../store"
import { RuntimeStoreSchemaMismatchError } from "../store-schema"

/**
 * A workspace host's store and the launch ownership kept beside it, opened on
 * first use. Nothing opens at mount, so a store this build refuses answers each
 * request with a typed 503 instead of failing the host that mounts it.
 */
export function workspaceDurableState(input: {
  open: () => RuntimeStore
  launchOwner: LaunchOwnershipOwner
  closing: () => boolean
}) {
  let opened: { store: RuntimeStore; launches: LaunchOwnershipStore } | undefined
  let reconciliation: Promise<LaunchOwnershipReconciliation> | undefined
  let summary: LaunchOwnershipReconciliation | undefined

  function open() {
    if (opened) return opened
    if (input.closing()) throw new HTTPException(503, { message: "Workspace runtime is disposed" })
    let store: RuntimeStore
    try {
      store = input.open()
    } catch (error) {
      if (!(error instanceof RuntimeStoreSchemaMismatchError)) throw error
      throw new HTTPException(503, { res: Response.json(errorBody(error.code, error.message), { status: 503 }) })
    }
    opened = { store, launches: sqliteLaunchOwnership(store.database(), input.launchOwner) }
    // Started before anything else this store does, because until it has
    // run the processes of a previous owner still hold this workspace's
    // ports, working directories and agent session storage, and nothing
    // else in the system is looking for them.
    reconciliation = reconcileLaunchOwnership(opened.launches, {
      currentOwnerGeneration: input.launchOwner.ownerGeneration,
      scope: input.launchOwner.scope,
      budgets: DEFAULT_RECOVERY_BUDGETS,
    }).then((settled) => {
      summary = settled
      return settled
    })
    store.recoverBusySessions()
    return opened
  }

  const store = () => open().store

  const sessionStarts: AgentSessionStarts = {
    get: (sessionId) => store().sessionStarts.get(sessionId),
    begin: (binding) => store().sessionStarts.begin(binding),
    finish: (binding, outcome) => store().sessionStarts.finish(binding, outcome),
    retire: (binding) => store().sessionStarts.retire(binding),
  }

  return {
    store,
    launchOwnership: () => open().launches,
    sessionStarts,
    launchReconciliation: () => reconciliation,
    launchSummary: () => summary,
    /** Refuses a write while a previous owner's launch is still unresolved. */
    async assertLaunchAdmission() {
      open()
      if (!reconciliation) return
      const settled = await reconciliation
      if (settled.unresolved.length === 0) return
      throw new HTTPException(503, {
        message: `workspace_launch_unreconciled: ${settled.unresolved
          .map((row) => `${row.launchId} (${row.outcome}: ${row.reason})`)
          .join("; ")}`,
      })
    },
    flush: () => opened?.store.flush(),
    close() {
      opened?.store.close()
      opened = undefined
    },
  }
}
