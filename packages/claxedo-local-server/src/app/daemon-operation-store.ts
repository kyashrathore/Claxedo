/**
 * Machine-scope recovery receipts, in this machine's own database.
 *
 * Workspace ownership belongs to each workspace's `RuntimeStore`. What lives
 * here is the other half: a drain or a stop names owners across every workspace
 * at once, so no single workspace store can hold the authorization that covers
 * them, and the gate acknowledgements have to outlive the process that
 * collected them.
 *
 * The authorized intent is written before any destructive step and each owner's
 * gate is written before the owner acknowledges it, so a crash between the two
 * writes is reconciled by reading the gate rather than by assuming it was never
 * taken.
 */

import {
  normalizeRecoveryIntent,
  parseRecoveryOperation,
  type RecoveryIntent,
  type RecoveryOperation,
  type RecoveryRequest,
} from "@claxedo/agent-runtime-contract"
import { recoveryScopeKey } from "@claxedo/agent-sdk-runtime/adapters"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { isRecord } from "../platform/json"

/** The SQLite operations this store uses; both the Node and bundled drivers implement it. */
export type DaemonOperationSqliteDatabase = {
  exec(sql: string): unknown
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): unknown
  }
  transaction<T>(fn: () => T): () => T
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS daemon_recovery_operation (
  operation_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  caller_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  intent_json TEXT NOT NULL,
  state TEXT NOT NULL,
  scope_revision TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  data_json TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS daemon_recovery_operation_request
  ON daemon_recovery_operation (scope_key, caller_id, request_id);

CREATE TABLE IF NOT EXISTS daemon_recovery_gate (
  operation_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_generation TEXT NOT NULL,
  acknowledged_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, owner_id)
);
`

export type DaemonOperationGate = {
  operationId: string
  ownerId: string
  ownerGeneration: string
  acknowledgedAt: number
}

export type DaemonOperationRecord =
  | { created: true }
  | { created: false; existing: RecoveryOperation; intent: RecoveryIntent }

/**
 * An operation nothing has settled. Machine ingress stays closed while one of
 * these exists: the drain that opened it may already have stopped owners, and
 * reopening on a restart would admit work into a scope that was authorized for
 * removal.
 */
const OUTSTANDING_STATES = ["accepted", "running", "needs_action"] as const

export class DaemonOperationStore {
  constructor(private readonly db: DaemonOperationSqliteDatabase) {
    db.exec(SCHEMA)
  }

  /**
   * Claim one request id for one caller at one machine scope. The unique index
   * settles the race between two writers, so a redelivered request joins the
   * operation that won instead of issuing the effect a second time; the caller
   * compares the returned intent and refuses a different one.
   */
  record(operation: RecoveryOperation, caller: { callerId: string }, request: RecoveryRequest): DaemonOperationRecord {
    const scopeKey = recoveryScopeKey(operation.target)
    const intent = normalizeRecoveryIntent(request)
    return this.db.transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO daemon_recovery_operation(
          operation_id, scope_key, caller_id, request_id, intent_json, state, scope_revision, created_at, updated_at, data_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        operation.operationId,
        scopeKey,
        caller.callerId,
        operation.requestId,
        JSON.stringify(intent),
        operation.state,
        operation.scopeRevision,
        operation.createdAt,
        operation.updatedAt,
        JSON.stringify(operation),
      )
      const row = this.db.prepare(
        "SELECT operation_id, intent_json, data_json FROM daemon_recovery_operation WHERE scope_key = ? AND caller_id = ? AND request_id = ?",
      ).get(scopeKey, caller.callerId, operation.requestId)
      const found = operationRow(row)
      if (found.operationId === operation.operationId) return { created: true as const }
      return { created: false as const, existing: found.operation, intent: found.intent }
    })()
  }

  update(operation: RecoveryOperation): void {
    this.db.transaction(() => {
      const changed = this.db.prepare(`
        UPDATE daemon_recovery_operation
        SET state = ?, scope_revision = ?, updated_at = ?, data_json = ?
        WHERE operation_id = ?
      `).run(
        operation.state,
        operation.scopeRevision,
        operation.updatedAt,
        JSON.stringify(operation),
        operation.operationId,
      )
      if (isRecord(changed) && changed.changes === 0) {
        throw new Error(
          `Machine recovery operation ${operation.operationId} is not recorded on this machine; `
            + "it was never created here, or it settled and was pruned",
        )
      }
    })()
  }

  read(operationId: string): RecoveryOperation | undefined {
    const row = this.db.prepare("SELECT operation_id, intent_json, data_json FROM daemon_recovery_operation WHERE operation_id = ?")
      .get(operationId)
    return row === undefined || row === null ? undefined : operationRow(row).operation
  }

  /** Every machine operation nothing has settled, oldest first. */
  outstanding(): RecoveryOperation[] {
    const placeholders = OUTSTANDING_STATES.map(() => "?").join(", ")
    const rows = this.db.prepare(
      `SELECT operation_id, intent_json, data_json FROM daemon_recovery_operation WHERE state IN (${placeholders}) ORDER BY created_at ASC`,
    ).all(...OUTSTANDING_STATES)
    return rows.map((row) => operationRow(row).operation)
  }

  list(limit: number): RecoveryOperation[] {
    const rows = this.db.prepare(
      "SELECT operation_id, intent_json, data_json FROM daemon_recovery_operation ORDER BY updated_at DESC LIMIT ?",
    ).all(limit)
    return rows.map((row) => operationRow(row).operation)
  }

  /**
   * An owner's gate, written before that owner is told it is gated. Repeating
   * it for the same generation is the same gate; a different generation is a
   * different owner wearing the same id, so the earlier acknowledgement is kept
   * and reported rather than overwritten.
   */
  acknowledgeGate(gate: DaemonOperationGate): { accepted: boolean; existing: DaemonOperationGate } {
    return this.db.transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO daemon_recovery_gate(operation_id, owner_id, owner_generation, acknowledged_at)
        VALUES (?, ?, ?, ?)
      `).run(gate.operationId, gate.ownerId, gate.ownerGeneration, gate.acknowledgedAt)
      const row = this.db.prepare(
        "SELECT operation_id, owner_id, owner_generation, acknowledged_at FROM daemon_recovery_gate WHERE operation_id = ? AND owner_id = ?",
      ).get(gate.operationId, gate.ownerId)
      const existing = gateRow(row)
      return { accepted: existing.ownerGeneration === gate.ownerGeneration, existing }
    })()
  }

  gates(operationId: string): DaemonOperationGate[] {
    const rows = this.db.prepare(
      "SELECT operation_id, owner_id, owner_generation, acknowledged_at FROM daemon_recovery_gate WHERE operation_id = ? ORDER BY owner_id ASC",
    ).all(operationId)
    return rows.map(gateRow)
  }

  /**
   * Drops settled operations older than the cutoff. A gate outlives its
   * operation only if that operation is still outstanding, so the two are
   * deleted together and an unresolved owner is never forgotten.
   */
  prune(before: number): void {
    this.db.transaction(() => {
      const placeholders = OUTSTANDING_STATES.map(() => "?").join(", ")
      this.db.prepare(
        `DELETE FROM daemon_recovery_gate WHERE operation_id IN (
           SELECT operation_id FROM daemon_recovery_operation WHERE updated_at < ? AND state NOT IN (${placeholders})
         )`,
      ).run(before, ...OUTSTANDING_STATES)
      this.db.prepare(
        `DELETE FROM daemon_recovery_operation WHERE updated_at < ? AND state NOT IN (${placeholders})`,
      ).run(before, ...OUTSTANDING_STATES)
    })()
  }
}

function operationRow(row: unknown): { operationId: string; operation: RecoveryOperation; intent: RecoveryIntent } {
  if (!isRecord(row) || typeof row.operation_id !== "string" || typeof row.data_json !== "string" || typeof row.intent_json !== "string") {
    throw new Error("SQLite returned an invalid machine recovery operation row")
  }
  return {
    operationId: row.operation_id,
    operation: parseRecoveryOperation(JSON.parse(row.data_json)),
    intent: JSON.parse(row.intent_json) as RecoveryIntent,
  }
}

function gateRow(row: unknown): DaemonOperationGate {
  if (
    !isRecord(row) || typeof row.operation_id !== "string" || typeof row.owner_id !== "string"
    || typeof row.owner_generation !== "string" || typeof row.acknowledged_at !== "number"
  ) {
    throw new Error("SQLite returned an invalid machine recovery gate row")
  }
  return {
    operationId: row.operation_id,
    ownerId: row.owner_id,
    ownerGeneration: row.owner_generation,
    acknowledgedAt: row.acknowledged_at,
  }
}

/**
 * The store this machine's daemon uses, opened on first read. The daemon
 * lifecycle is composed before the database is, so a store built eagerly would
 * open `claxedo.db` too early.
 */
export function localDaemonOperationStore(): () => DaemonOperationStore {
  let store: DaemonOperationStore | undefined
  return () => (store ??= new DaemonOperationStore(ClaxedoDB.raw()))
}
