import type { SessionId, Token, Wake, WakeId, WakeState, WorkspaceId } from "./types"

/**
 * The porting surface. An adapter (SQLite / Convex / Postgres) implements this;
 * the wakes engine talks only to it. Every method is async so a network-backed
 * adapter (Convex) fits the same port as an embedded one (SQLite). The three
 * atomicity-critical operations are `insert` (idempotency-keyed dedup),
 * `claimDue`/`cas` (the guarded transitions), and the effect-receipt pair.
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
   */
  claimDue(nowMs: number, leaseMs: number, limit: number, serialKey?: string | null): Promise<Wake[]>

  /**
   * The guarded transition: set state `to` (+ patch) only if current state is `from`.
   * Returns whether it applied. This is the single serialization point for a wake.
   */
  cas(id: WakeId, from: WakeState, to: WakeState, patch?: Partial<Wake>): Promise<boolean>

  findPendingByEventKey(eventKey: string): Promise<Wake[]>
  /** Pending wakes past their expiry (any trigger type). */
  findExpirable(nowMs: number): Promise<Wake[]>
  /**
   * Atomically re-claim `firing` rows whose lease is at or before `nowMs`:
   * re-stamp the lease to `nowMs + leaseMs` and return only the rows this call
   * actually won. Because the winning caller pushes the lease past `nowMs`, a
   * concurrent reclaimer sees nothing — so the caller may re-drive the returned
   * rows without racing a second driver into the same side effect. `serialKey`
   * scopes like `claimDue`.
   */
  reclaimFiring(nowMs: number, leaseMs: number, serialKey?: string | null): Promise<Wake[]>
  /**
   * `firing` rows — the boot-sweep set. `serialKey` scopes like `claimDue` so
   * a pushed lane can read the exact live lease that currently blocks it.
   */
  listFiring(serialKey?: string | null): Promise<Wake[]>
  listForSession(sessionId: SessionId): Promise<Wake[]>

  // budget counters
  countLive(workspaceId: WorkspaceId): Promise<number>
  countCreatedSince(workspaceId: WorkspaceId, sinceMs: number): Promise<number>

  // effect receipts (for `once`)
  getReceipt(key: string): Promise<string | null>
  putReceipt(key: string, resultJson: string): Promise<void>

  /** Delete terminal wakes older than `beforeMs`. Returns rows removed. */
  gc(beforeMs: number): Promise<number>
}
