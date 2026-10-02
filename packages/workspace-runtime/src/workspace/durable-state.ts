import { DEFAULT_RECOVERY_BUDGETS, type AgentSessionStarts } from "@claxedo/agent-runtime-contract"
import type { LaunchOwnershipOwner, LaunchOwnershipStore } from "@claxedo/process-ownership/launch"
import type { MiddlewareHandler } from "hono"
import { HTTPException } from "hono/http-exception"
import { Log } from "../log"
import { sqliteLaunchOwnership } from "../ownership/launch-ownership-sqlite"
import { reconcileLaunchOwnership, type LaunchOwnershipReconciliation } from "../ownership/reconcile-launch-ownership"
import { errorBody, type RuntimeStore, RuntimeStoreSchemaMismatchError } from "@claxedo/session-core"

const log = Log.create({ service: "workspace-runtime" })

/**
 * A workspace host's store and the launch ownership kept beside it. Nothing
 * that can fail the host opens it, so a store this build refuses answers each
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
  const openers: Array<(store: RuntimeStore) => void> = []

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
    for (const opener of openers) opener(store)
    return opened
  }

  const store = () => open().store

  const sessionStarts: AgentSessionStarts = {
    get: (sessionId) => store().sessionStarts.get(sessionId),
    begin: (binding) => store().sessionStarts.begin(binding),
    finish: (binding, outcome) => store().sessionStarts.finish(binding, outcome),
    retire: (binding) => store().sessionStarts.retire(binding),
  }

  function whenOpened(opener: (store: RuntimeStore) => void) {
    if (opened) opener(opened.store)
    else openers.push(opener)
  }

  /**
   * A read needs the store open; a write also waits out launch
   * reconciliation and is refused while a previous owner's launch is
   * unresolved. Answers the refusal, or nothing when the request may run.
   */
  async function admit(method: string): Promise<Response | undefined> {
    try {
      open()
    } catch (error) {
      if (!(error instanceof HTTPException)) throw error
      return error.getResponse()
    }
    if (["GET", "HEAD", "OPTIONS"].includes(method) || !reconciliation) return undefined
    const settled = await reconciliation
    if (settled.unresolved.length === 0) return undefined
    const launches = settled.unresolved.map(({ launchId, role, outcome, reason }) => ({ launchId, role, outcome, reason }))
    return Response.json(errorBody("workspace_launch_unreconciled", "Launches a previous owner of this workspace left are unresolved", { launches }), { status: 503 })
  }

  return {
    store,
    whenOpened,
    launchOwnership: () => open().launches,
    sessionStarts,
    launchReconciliation: () => reconciliation,
    launchSummary: () => summary,
    admit,
    /**
     * Opens the store now and runs `work` once it is open. A store this build
     * refuses stays closed, `work` never runs, and requests answer the refusal.
     */
    whenAdmitted(what: string, work: () => Promise<void>) {
      let pending = true
      const failed = (error: unknown) => log.error(`${what} failed`, { error })
      whenOpened(() => {
        if (!pending) return
        pending = false
        work().catch(failed)
      })
      admit("GET").catch(failed)
    },
    /** For the routes mounted ahead of the host's gate: admit the store before any filesystem or Git work. */
    admission: (async (_c, next) => {
      store()
      await next()
    }) satisfies MiddlewareHandler,
    flush: () => opened?.store.flush(),
    close() {
      opened?.store.close()
      opened = undefined
    },
  }
}
