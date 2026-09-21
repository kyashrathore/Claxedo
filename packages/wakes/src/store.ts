import type { SessionId, Token, Wake, WakeId, WakeState, WorkspaceId } from "./types"

export type ReceiptClaim =
  /** This call won the claim; the caller runs the effect, then `completeReceipt`. */
  | { status: "claimed"; claimedAtMs: number }
  /** Another caller holds an unexpired claim; poll again for its result. */
  | { status: "running" }
  /** A result is already recorded; the caller must not run the effect. */
  | { status: "completed"; resultJson: string }

/**
 * The porting surface. An adapter (SQLite / Postgres / a network store)
 * implements this; the wakes engine talks only to it. Every method is async so
 * a network-backed adapter fits the same port as an embedded one (SQLite). The
 * atomicity-critical operations are `insert` (idempotency-keyed dedup),
 * `claimDue`/`cas` (the guarded transitions), `reclaimFiring` (re-stamp and
 * return in one statement), and `claimReceipt` (the `once` claim).
 * Everything else is a plain read.
 */
export interface WakeStore {
  /** Insert a new wake. Returns false (and does nothing) if idempotencyKey collides. */
  insert(wake: Wake): Promise<{ inserted: boolean }>
  get(id: WakeId): Promise<Wake | null>
  getByToken(token: Token): Promise<Wake | null>
  getByIdempotencyKey(workspaceId: WorkspaceId, key: string): Promise<Wake | null>

  /**
   * Atomically claim due `at` wakes: `pending → firing`, stamping a lease.
   * Returns the claimed rows (already in `firing`). Must be safe under
   * concurrency, and must honor serialization lanes: never claim a wake whose
   * `serialKey` already has a `firing` row, and never claim two wakes of the
   * same key in one batch (earliest per key wins; null keys are unrestricted).
   * `serialKey` scopes the claim to one lane: a string claims only that key,
   * null claims only null-key wakes, undefined claims across all lanes.
   * Expiry is checked in the claim itself: expiresAt <= nowMs is never eligible.
   */
  claimDue(nowMs: number, leaseMs: number, limit: number, serialKey?: string | null): Promise<Wake[]>

  /**
   * The guarded transition: set state `to` (+ patch) only if current state is `from`.
   * Returns whether it applied. This is the single serialization point for a wake.
   * Pending-to-firing requires no deadline or expiresAt > nowMs; pending-to-expired
   * requires expiresAt <= nowMs. Both predicates must be checked atomically.
   */
  cas(id: WakeId, from: WakeState, to: WakeState, nowMs: number, patch?: Partial<Wake>): Promise<boolean>

  /**
   * Pending `on_event` watches for one workspace and key. The workspace scope
   * is part of the delivery contract — `deliverEvent` addresses a tenant, and
   * a colliding `eventKey` in another workspace must never match.
   */
  findPendingByEventKey(workspaceId: WorkspaceId, eventKey: string): Promise<Wake[]>
  /**
   * Pending wakes past their expiry (any trigger type). `serialKey` scopes like
   * `claimDue`, so a lane-scoped driver sweeps its own deadlines without
   * terminalizing another lane's rows.
   */
  findExpirable(nowMs: number, serialKey?: string | null): Promise<Wake[]>
  /**
   * Atomically re-claim `firing` rows whose lease is at or before `nowMs`:
   * re-stamp the lease to `nowMs + leaseMs` and return only the rows this call
   * actually won. Because the winning caller pushes the lease past `nowMs`, a
   * concurrent reclaimer sees nothing — so the caller may re-drive the returned
   * rows without racing a second driver into the same side effect. `serialKey`
   * scopes like `claimDue`.
   *
   * `expiresAt` is an admission deadline, not a delivery deadline: it gates
   * `pending → firing` only. A row already in `firing` won its deadline-checked
   * CAS and its result is persisted, so reclaim re-drives it however late the
   * lease lapsed. Filtering reclaim by `expiresAt` would drop an approval whose
   * answer was accepted in time and whose sink then crashed.
   */
  reclaimFiring(nowMs: number, leaseMs: number, serialKey?: string | null): Promise<Wake[]>
  /**
   * The earliest time a `runDue(serialKey)` on this lane could next make
   * progress, or null when the lane owes no time-based work: the soonest
   * deadline among its pending rows, lease boundary among its `firing` rows,
   * and fire time among its claimable pending `at` rows.
   *
   * A keyed lane already holding a `firing` row cannot claim, so its blocked
   * fire times are not obligations yet — the occupying lease is the boundary,
   * and reporting the blocked (often already past) fire time would spin a
   * driver that arms timers from this. Null-key wakes share no lane and are
   * never blocked.
   *
   * This is the whole answer to "when should this lane wake up again", so a
   * push driver re-derives it after every drain rather than trusting the
   * lossy hints it was nudged with.
   */
  nextObligationAt(serialKey: string | null): Promise<number | null>
  /** Every `firing` row — a diagnostic read, no lane scope. */
  listFiring(): Promise<Wake[]>
  listForSession(sessionId: SessionId): Promise<Wake[]>

  // budget counters
  countLive(workspaceId: WorkspaceId): Promise<number>
  countCreatedSince(workspaceId: WorkspaceId, sinceMs: number): Promise<number>

  // effect receipts (for `once`)

  /**
   * Atomically claim the right to run the effect for `key`, or report its
   * outcome. A claim holds a lease until `nowMs + leaseMs`: while it is live
   * other callers see "running" and wait; once it lapses the key is
   * re-claimable, so a producer that crashed before `completeReceipt` frees
   * the key instead of wedging it. A completed receipt is never re-claimed.
   * The claim decision must happen in one statement — a read-then-write pair
   * lets two racing callers both run the effect.
   */
  claimReceipt(key: string, nowMs: number, leaseMs: number): Promise<ReceiptClaim>
  /**
   * Record the winning claimant's result, bound to the exact claim by
   * `claimedAtMs`: a claimant whose lease lapsed and lost the key to a
   * re-claim must not overwrite the newer claim or an already-recorded
   * result.
   */
  completeReceipt(key: string, claimedAtMs: number, resultJson: string): Promise<void>

  /** Delete terminal wakes older than `beforeMs`. Returns rows removed. */
  gc(beforeMs: number): Promise<number>
}
