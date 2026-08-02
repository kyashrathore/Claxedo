import type BetterSqlite3 from "better-sqlite3"
import type { WorkGraphContext } from "@claxedo/workgraph/contracts"
import type { WorkgraphChangedEvent } from "../../lib/bus"

/**
 * WorkGraph live-sync doorbell (plan 2026-07-17-004).
 *
 * Replaces the deleted `GET /api/workgraph/changes` long-poll. Publishers here
 * emit a lightweight `workgraph.changed` nudge on `claxedoBus`; the client
 * re-reads the snapshot + attention. The ordered `wg_v2_changes` log is
 * untouched and stays server-side for settlement/wakes/audit.
 *
 * Publish points, and why each exists:
 *
 * 1. `instrumentWorkGraphChangeDoorbell(service)` — every WorkGraph command
 *    (HTTP router, intake host, MCP, agent tools) funnels through
 *    `service.execute`. Its promise resolves only after the better-sqlite3
 *    transaction that appends the `wg_v2_changes` row has committed, so
 *    resolution IS the post-commit point: a client that reloads on this nudge
 *    is guaranteed to read the committed change.
 * 2. `instrumentAttentionDoorbell(attentionAcknowledgements)` — ATTENTION
 *    PARITY. `wg_v2_attention_acknowledgements` writes (mark-all-read, clear)
 *    append NO change row, so they would be invisible to a log-derived nudge.
 *    They get their own unconditional nudge.
 * 3. `createWorkGraphChangeTipWatcher(...).observe(context)` — safety net for
 *    writers that bypass both seams (activity store, intake stores, recap and
 *    source-planning runtimes, Run settlement, archive restore). The server
 *    reconciler calls it once per owner per tick; it compares the log tip and
 *    nudges only when it advanced, so an idle owner costs zero events.
 *
 * Under-nudging is a correctness bug; over-nudging is merely wasteful — when in
 * doubt, nudge. But note that "wasteful" is not free: plan §3 deleted the client
 * cursor, so the client CANNOT recognise a nudge for a tip it has already seen
 * and pays a full snapshot+attention reload for every one. Publish points that
 * can cheaply prove they are redundant should do so (see `adopt`), because the
 * redundancy lands exactly during agent churn, when the client is busiest.
 */
export type WorkGraphChangeDoorbell = Readonly<{
  /** Request a nudge for this owner. Coalesced; safe to call at any rate. */
  nudge: (ownerUserId: string, change?: Readonly<{ cursor?: string; streamId?: string }>) => void
  /** Cancel pending nudges (server shutdown). */
  dispose: () => void
}>

export function createWorkGraphChangeDoorbell(
  input: Readonly<{
    publish: (event: WorkgraphChangedEvent) => void
    /** Trailing coalesce window. A burst inside it emits exactly one nudge. */
    coalesceMs?: number
    now?: () => number
  }>,
): WorkGraphChangeDoorbell {
  const coalesceMs = Math.max(0, input.coalesceMs ?? 100)
  const now = input.now ?? Date.now
  const pending = new Map<string, {
    timer: ReturnType<typeof setTimeout>
    change?: Readonly<{ cursor?: string; streamId?: string }>
  }>()

  return {
    nudge(ownerUserId, change) {
      // Trailing and NON-resetting: the first nudge of a burst arms the timer and
      // later ones ride it. A resetting debounce would starve the client under
      // continuous agent churn — exactly when it most needs to be current.
      const existing = pending.get(ownerUserId)
      if (existing) {
        existing.change = change ?? existing.change
        return
      }
      const timer = setTimeout(() => {
        const queued = pending.get(ownerUserId)
        pending.delete(ownerUserId)
        try {
          input.publish({
            type: "workgraph.changed",
            ownerUserId,
            ...(queued?.change?.cursor ? { cursor: queued.change.cursor } : {}),
            ...(queued?.change?.streamId ? { streamId: queued.change.streamId } : {}),
            ts: now(),
          })
        } catch (error) {
          console.error("[claxedo-server] WARN  workgraph.changed publish failed:", error)
        }
      }, coalesceMs)
      // A doorbell must never hold the process open.
      ;(timer as { unref?: () => void }).unref?.()
      pending.set(ownerUserId, { timer, ...(change ? { change } : {}) })
    },
    dispose() {
      pending.forEach(({ timer }) => clearTimeout(timer))
      pending.clear()
    },
  }
}

/**
 * Nudge after every successful command. `execute` resolving means the SQLite
 * transaction committed, so this is the post-commit publish point for the
 * command path.
 */
export function instrumentWorkGraphChangeDoorbell<
  Service extends Readonly<{
    execute(context: WorkGraphContext, request: never): Promise<Readonly<{ ok: boolean }>>
  }>,
>(service: Service, doorbell: WorkGraphChangeDoorbell, tips?: WorkGraphChangeTipWatcher): Service {
  return {
    ...service,
    async execute(context: WorkGraphContext, request: never) {
      const result = await service.execute(context, request)
      // Failed commands append nothing. A rare no-op `ok` command over-nudges,
      // which the client absorbs; the alternative (inspecting the log tip on the
      // hot command path) buys nothing.
      if (result.ok) {
        const change = result as Readonly<{ cursor?: string }>
        const command = request as Readonly<{ command?: Readonly<{ streamId?: string }> }>
        doorbell.nudge(context.ownerUserId, {
          ...(change.cursor ? { cursor: change.cursor } : {}),
          ...(command.command?.streamId ? { streamId: command.command.streamId } : {}),
        })
        // This command's own row has now advanced the tip. Hand that tip to the
        // watcher as already-seen, or its next tick rings a SECOND time for the
        // change we just announced — the two are ~1s apart, so no debounce folds
        // them and the client pays a full duplicate reload per command.
        tips?.adopt(context)
      }
      return result
    },
  }
}

/**
 * ATTENTION PARITY (plan §6). Attention acknowledgements mutate only
 * `wg_v2_attention_acknowledgements` — no `wg_v2_changes` row — so an
 * attention-only transition such as mark-all-read from a second client would
 * never reach the first client without this nudge.
 */
export function instrumentAttentionDoorbell<
  Service extends Readonly<{
    markAllRead(context: WorkGraphContext): Promise<unknown>
    clear(context: WorkGraphContext): Promise<unknown>
  }>,
>(service: Service, doorbell: WorkGraphChangeDoorbell): Service {
  return {
    ...service,
    async markAllRead(context: WorkGraphContext) {
      const result = await service.markAllRead(context)
      doorbell.nudge(context.ownerUserId)
      return result
    },
    async clear(context: WorkGraphContext) {
      const result = await service.clear(context)
      doorbell.nudge(context.ownerUserId)
      return result
    },
  }
}

export type WorkGraphChangeTipWatcher = Readonly<{
  /** Nudge iff this owner's change-log tip advanced since the last observation. */
  observe: (context: Readonly<{ organizationId: string; ownerUserId: string }>) => void
  /**
   * Adopt the current tip as seen WITHOUT nudging. The command path calls this
   * after it has already nudged for its own commit, so the watcher does not ring
   * a second time for the very change the command just announced.
   */
  adopt: (context: Readonly<{ organizationId: string; ownerUserId: string }>) => void
  forget: (context: Readonly<{ organizationId: string; ownerUserId: string }>) => void
}>

/**
 * Tip-conditional safety net. Reads the owner's `wg_v2_changes` high-water mark
 * — a `MAX(cursor)` over the table's primary key `(organization_id,
 * owner_user_id, cursor)`, so an index lookup, not a scan — and nudges only on
 * advance. This catches every writer that does not pass through `service.execute`
 * without the client paying for polling: an owner whose tip is unchanged emits
 * nothing.
 *
 * The first observation of an owner seeds the baseline silently. That is
 * intentional: at seeding time either the process just started (any client
 * revalidates on events-stream reconnect anyway) or the owner is new (whose
 * first mutation is a command, already nudged directly).
 */
export function createWorkGraphChangeTipWatcher(
  input: Readonly<{
    database: BetterSqlite3.Database
    doorbell: WorkGraphChangeDoorbell
  }>,
): WorkGraphChangeTipWatcher {
  // Keyed by org+owner, matching readTip's scope. Keying by ownerUserId alone
  // lets the same owner in two organizations share a baseline, which SUPPRESSES
  // nudges (a lower-tip org compares against a higher-tip one and reads as
  // "unchanged") — a missed nudge is silent staleness.
  const seen = new Map<string, number>()
  const baselineKey = (organizationId: string, ownerUserId: string) =>
    `${organizationId}\u0000${ownerUserId}`
  const readTip = (organizationId: string, ownerUserId: string) => {
    const row = input.database
      .prepare(
        "SELECT MAX(cursor) AS tip FROM wg_v2_changes WHERE organization_id = ? AND owner_user_id = ?",
      )
      .get(organizationId, ownerUserId) as { tip: number | null } | undefined
    return Number(row?.tip ?? 0)
  }

  return {
    observe(context) {
      const key = baselineKey(context.organizationId, context.ownerUserId)
      const tip = readTip(context.organizationId, context.ownerUserId)
      const previous = seen.get(key)
      seen.set(key, tip)
      if (previous === undefined || tip <= previous) return
      input.doorbell.nudge(context.ownerUserId)
    },
    adopt(context) {
      // Safe against under-nudging: the caller has already nudged, and the reload
      // that nudge triggers reads the whole snapshot — so every row at or below
      // this tip reaches the client regardless of who appended it.
      seen.set(
        baselineKey(context.organizationId, context.ownerUserId),
        readTip(context.organizationId, context.ownerUserId),
      )
    },
    forget(context) {
      seen.delete(baselineKey(context.organizationId, context.ownerUserId))
    },
  }
}
