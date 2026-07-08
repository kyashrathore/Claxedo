import type { SessionId, Token, Wake, WakeId, WakeState, WorkspaceId } from "./types"

/**
 * The porting surface. An adapter (SQLite / Convex / Postgres) implements this;
 * the wakes engine talks only to it. The three atomicity-critical operations are
 * `insert` (idempotency-keyed dedup), `claimDue`/`cas` (the guarded transitions),
 * and the effect-receipt pair. Everything else is a plain read.
 */
export interface WakeStore {
  /** Insert a new wake. Returns false (and does nothing) if idempotencyKey collides. */
  insert(wake: Wake): { inserted: boolean }
  get(id: WakeId): Wake | null
  getByToken(token: Token): Wake | null
  getByIdempotencyKey(workspaceId: WorkspaceId, key: string): Wake | null

  /**
   * Atomically claim due `at` wakes: `pending → firing`, stamping a lease.
   * Returns the claimed rows (already in `firing`). Must be safe under concurrency.
   */
  claimDue(nowMs: number, leaseMs: number, limit: number): Wake[]

  /**
   * The guarded transition: set state `to` (+ patch) only if current state is `from`.
   * Returns whether it applied. This is the single serialization point for a wake.
   */
  cas(id: WakeId, from: WakeState, to: WakeState, patch?: Partial<Wake>): boolean

  findPendingByEventKey(eventKey: string): Wake[]
  /** Pending wakes past their expiry (any trigger type). */
  findExpirable(nowMs: number): Wake[]
  /** `firing` rows whose lease has lapsed (crashed mid-fire) — reclaim + re-drive. */
  findReclaimable(nowMs: number): Wake[]
  /** All `firing` rows — the boot-sweep set. */
  listFiring(): Wake[]
  listForSession(sessionId: SessionId): Wake[]

  // budget counters
  countLive(workspaceId: WorkspaceId): number
  countCreatedSince(workspaceId: WorkspaceId, sinceMs: number): number

  // effect receipts (for `once`)
  getReceipt(key: string): string | null
  putReceipt(key: string, resultJson: string): void

  /** Delete terminal wakes older than `beforeMs`. Returns rows removed. */
  gc(beforeMs: number): number
}
