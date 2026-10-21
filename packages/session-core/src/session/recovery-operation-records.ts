import {
  RECOVERY_OPERATION_RETENTION_MS,
  parseRecoveryOperation,
  recoveryScopeKey,
  recoveryTargetSessionId,
  type RecoveryOperation,
} from "@claxedo/agent-runtime-contract"
import type { SqliteDatabase } from "../sqlite/database"

/**
 * The durable receipts of recovery operations and the callers each one may be
 * read by. Two runtimes sharing one store share these rows, so a request id
 * claims one operation across both.
 */
export class RecoveryOperationRecords {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * Claim one recovery request id for one caller. The unique index decides the
   * race, so two runtimes sharing this store cannot both believe they created
   * the operation; the loser reads back the row that won.
   */
  record(operation: RecoveryOperation, caller: { callerId: string }) {
    this.prune()
    const scopeKey = recoveryScopeKey(operation.target)
    const created = this.db
      .prepare(
        `
        INSERT OR IGNORE INTO recovery_operation (
          operation_id, scope_key, caller_id, request_id, session_id, action, state,
          cleanup_fact, persistence_fact, created_at, updated_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        operation.operationId,
        scopeKey,
        caller.callerId,
        operation.requestId,
        recoveryTargetSessionId(operation.target),
        operation.action,
        operation.state,
        operation.facts.cleanup.value,
        operation.facts.persistence.value,
        operation.createdAt,
        operation.updatedAt,
        JSON.stringify(operation),
      )
    if (created.changes === 1) {
      this.db
        .prepare("INSERT OR IGNORE INTO recovery_operation_caller (operation_id, caller_id) VALUES (?, ?)")
        .run(operation.operationId, caller.callerId)
      return { created: true as const }
    }
    const existing = this.db
      .prepare<{ payload_json: string }>(
        "SELECT payload_json FROM recovery_operation WHERE scope_key = ? AND caller_id = ? AND request_id = ?",
      )
      .get(scopeKey, caller.callerId, operation.requestId)
    if (!existing) throw new Error("missing recovery_operation existing row")
    return { created: false as const, existing: parseRecoveryOperation(JSON.parse(existing.payload_json)) }
  }

  /**
   * Takes no caller, unlike the read. An update is the owner writing what it
   * observed about work it is already performing; the read is a caller asking
   * for a receipt that names a turn and its owner generation. Only one of those
   * is a disclosure.
   */
  update(operation: RecoveryOperation) {
    const result = this.db
      .prepare(
        `
        UPDATE recovery_operation
        SET state = ?, cleanup_fact = ?, persistence_fact = ?, updated_at = ?, payload_json = ?
        WHERE operation_id = ?
      `,
      )
      .run(
        operation.state,
        operation.facts.cleanup.value,
        operation.facts.persistence.value,
        operation.updatedAt,
        JSON.stringify(operation),
        operation.operationId,
      )
    if (result.changes === 0) {
      throw new Error(
        `Recovery operation ${operation.operationId} is not recorded in this store; it was never created here, `
          + "or it settled with nothing outstanding and aged out",
      )
    }
  }

  /**
   * Record a caller that coalesced onto an operation someone else created. Its
   * own request id claimed nothing, so without this nothing would say it may
   * read the receipt of the effect being issued on its behalf. An id this
   * store does not hold records nobody: the caller list must not outlive the
   * operation it describes.
   */
  addCaller(operationId: string, caller: { callerId: string }) {
    if (!this.db.prepare("SELECT 1 FROM recovery_operation WHERE operation_id = ?").get(operationId)) return
    this.db
      .prepare("INSERT OR IGNORE INTO recovery_operation_caller (operation_id, caller_id) VALUES (?, ?)")
      .run(operationId, caller.callerId)
  }

  read(operationId: string, caller: { callerId: string }) {
    const row = this.db
      .prepare<{ payload_json: string }>(
        `
        SELECT op.payload_json FROM recovery_operation AS op
        JOIN recovery_operation_caller AS reader
          ON reader.operation_id = op.operation_id AND reader.caller_id = ?
        WHERE op.operation_id = ?
      `,
      )
      .get(caller.callerId, operationId)
    return row ? parseRecoveryOperation(JSON.parse(row.payload_json)) : undefined
  }

  /**
   * In-flight operations, plus the settled ones a caller could still be
   * holding a receipt for. Older settled rows are omitted rather than
   * presented as current work.
   */
  list(scope: { sessionId?: string } = {}) {
    const rows = this.db
      .prepare<{ payload_json: string }>(
        `
        SELECT payload_json FROM recovery_operation
        WHERE (? IS NULL OR session_id = ?)
          AND (
            state NOT IN ('succeeded', 'failed')
            OR updated_at >= ?
            OR cleanup_fact <> 'verified_clear'
            OR persistence_fact = 'pending'
          )
        ORDER BY updated_at DESC
      `,
      )
      .all(scope.sessionId ?? null, scope.sessionId ?? null, Date.now() - RECOVERY_OPERATION_RETENTION_MS)
    return rows.map((row) => parseRecoveryOperation(JSON.parse(row.payload_json)))
  }

  /**
   * Drop settled operations past the retention window. An operation whose
   * facts still say something is owned, unknown or unwritten is kept whatever
   * its age: deleting it would destroy the only record of an obligation
   * nobody has discharged.
   */
  private prune() {
    this.db.transaction(() => {
      const expired = `
        SELECT operation_id FROM recovery_operation
        WHERE state IN ('succeeded', 'failed')
          AND updated_at < ?
          AND cleanup_fact = 'verified_clear'
          AND persistence_fact <> 'pending'
      `
      const cutoff = Date.now() - RECOVERY_OPERATION_RETENTION_MS
      this.db.prepare(`DELETE FROM recovery_operation_caller WHERE operation_id IN (${expired})`).run(cutoff)
      this.db.prepare(`DELETE FROM recovery_operation WHERE operation_id IN (${expired})`).run(cutoff)
    })
  }
}
